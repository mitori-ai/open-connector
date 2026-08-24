import type { ActionExecutor, ProviderDefinition } from "../../core/types.ts";
import type { IProviderLoader } from "../../providers/provider-loader.ts";
import type { RuntimeActionHttpResult } from "../api/runtime-api.ts";
import type { ConnectApp } from "../connect-app.ts";
import type { RunLog } from "./runtime-store.ts";

import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogStore } from "../../catalog-store.ts";
import { ConnectionService } from "../../connection-service.ts";
import { parseTenantId } from "../../core/tenant.ts";
import { ActionRunner } from "../actions/action-runner.ts";
import { createLocalAuthMiddleware, readAuthenticatedPrincipal } from "../api/auth.ts";
import { createConnectApp } from "../connect-app.ts";
import { TransitFileService } from "../files/transit-files.ts";
import { AesGcmSecretCodec } from "../secrets/secret-codec.ts";
import { RuntimeTokenPolicyError, RuntimeTokenService } from "./runtime-token-service.ts";
import { SqliteRuntimeDatabase } from "./sqlite-runtime-store.ts";
import { TenantCredentialService } from "./tenant-credential-service.ts";

const tenantA = parseTenantId("tenant-a");
const tenantB = parseTenantId("tenant-b");
const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
describe("shared runtime tenant isolation", () => {
  it("requires viable runtime authentication before shared-mode startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "open-connector-shared-auth-"));
    temporaryDirectories.push(directory);
    const database = new SqliteRuntimeDatabase(join(directory, "runtime.sqlite"));

    await expect(
      createSharedTestApp(directory, database, {
        sharedRuntime: true,
      }),
    ).rejects.toThrow("Shared runtime authentication is not ready");

    database.close();
  });

  it("fails closed for empty, invalid, revoked, and disabled-tenant runtime credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "open-connector-shared-auth-"));
    temporaryDirectories.push(directory);
    const database = new SqliteRuntimeDatabase(join(directory, "runtime.sqlite"));
    const credentials = new TenantCredentialService(database.tenantCredentialStore);
    await credentials.createTenant({ id: tenantA, displayName: "Tenant A", createdAt: new Date().toISOString() });
    const tokens = new RuntimeTokenService(database.runtimeTokenStore, database.connectionStore);
    const firstToken = await tokens.createToken("runtime-a", undefined, tenantA);
    const { app } = await createSharedTestApp(directory, database, {
      sharedRuntime: true,
      verifyRuntimeJwt: async (token) =>
        token === "jwt-a"
          ? { kind: "tenant", capability: "runtime", tenantId: tenantA, runtimeTokenId: "jwt:a" }
          : undefined,
    });

    expect((await app.request("/v1/providers")).status).toBe(401);
    expect((await app.request("/v1/providers", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect(
      (await app.request("/v1/providers", { headers: { authorization: `Bearer ${firstToken.token}` } })).status,
    ).toBe(200);
    expect((await app.request("/v1/providers", { headers: { authorization: "Bearer jwt-a" } })).status).toBe(200);

    await tokens.revokeToken(firstToken.record.id, tenantA);
    expect((await app.request("/v1/providers")).status).toBe(401);
    expect(
      (await app.request("/v1/providers", { headers: { authorization: `Bearer ${firstToken.token}` } })).status,
    ).toBe(401);

    const secondToken = await tokens.createToken("runtime-a-2", undefined, tenantA);
    await database.tenantCredentialStore.disableTenant(tenantA, new Date().toISOString());
    expect(
      (await app.request("/v1/providers", { headers: { authorization: `Bearer ${secondToken.token}` } })).status,
    ).toBe(401);
    expect((await app.request("/v1/providers", { headers: { authorization: "Bearer jwt-a" } })).status).toBe(401);

    database.close();
  });

  it("introspects only the bearer-derived persistent runtime principal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "open-connector-shared-principal-"));
    temporaryDirectories.push(directory);
    const database = new SqliteRuntimeDatabase(join(directory, "runtime.sqlite"));
    const credentials = new TenantCredentialService(database.tenantCredentialStore);
    await credentials.createTenant({ id: tenantA, displayName: "Tenant A", createdAt: new Date().toISOString() });
    const tenantAdmin = await credentials.issueAdminCredential(tenantA, "Control Center");
    const tokens = new RuntimeTokenService(database.runtimeTokenStore, database.connectionStore);
    const runtime = await tokens.createToken("control-center", undefined, tenantA);
    const { app } = await createSharedTestApp(directory, database, {
      sharedRuntime: true,
      adminToken: "operator-secret",
      runtimeToken: "bootstrap-secret",
      verifyRuntimeJwt: async (token) =>
        token === "jwt-a"
          ? { kind: "tenant", capability: "runtime", tenantId: tenantA, runtimeTokenId: "jwt:a" }
          : undefined,
    });
    const authorization = { authorization: `Bearer ${runtime.token}` };

    const response = await app.request("/v1/principal", { headers: authorization });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      kind: "tenant",
      tenantId: tenantA,
      capability: "runtime",
      credentialId: runtime.record.id,
    });

    expect((await app.request("/v1/principal")).status).toBe(401);
    expect((await app.request("/v1/principal", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await app.request("/v1/principal", { headers: { authorization: "Bearer operator-secret" } })).status).toBe(
      401,
    );
    expect(
      (
        await app.request("/v1/principal", {
          headers: { authorization: `Bearer ${tenantAdmin.credential}` },
        })
      ).status,
    ).toBe(401);
    expect((await app.request("/v1/principal", { headers: { authorization: "Bearer bootstrap-secret" } })).status).toBe(
      401,
    );
    const jwtResponse = await app.request("/v1/principal", {
      headers: { authorization: "Bearer jwt-a" },
    });
    expect(jwtResponse.status).toBe(401);
    expect(await jwtResponse.text()).not.toContain("jwt:a");
    expect((await app.request(`/v1/principal?tenantId=${tenantB}`, { headers: authorization })).status).toBe(400);
    expect((await app.request(`/v1/principal?tenant_id=${tenantB}`, { headers: authorization })).status).toBe(400);
    expect(
      (
        await app.request("/v1/principal", {
          headers: { ...authorization, "x-tenant-id": tenantB },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request("/v1/principal", {
          headers: { ...authorization, tenant_id: tenantB },
        })
      ).status,
    ).toBe(400);
    const requestWithBody = new Request("http://localhost/v1/principal", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ tenantId: tenantB }),
    });
    // Server adapters can expose GET bodies even though the Fetch constructor does not create them.
    Object.defineProperty(requestWithBody, "method", { value: "GET" });
    expect((await app.fetch(requestWithBody)).status).toBe(400);

    await database.tenantCredentialStore.disableTenant(tenantA, new Date().toISOString());
    expect((await app.request("/v1/principal", { headers: authorization })).status).toBe(401);

    database.close();
  });

  it("lets an operator explicitly scope the console without opening the runtime plane", async () => {
    const directory = await mkdtemp(join(tmpdir(), "open-connector-operator-console-"));
    temporaryDirectories.push(directory);
    const database = new SqliteRuntimeDatabase(join(directory, "runtime.sqlite"));
    const credentials = new TenantCredentialService(database.tenantCredentialStore);
    await credentials.createTenant({ id: tenantA, displayName: "Tenant A", createdAt: new Date().toISOString() });
    await credentials.createTenant({ id: tenantB, displayName: "Tenant B", createdAt: new Date().toISOString() });
    const tokens = new RuntimeTokenService(database.runtimeTokenStore, database.connectionStore);
    await tokens.createToken("runtime-a", undefined, tenantA);
    const { app } = await createSharedTestApp(directory, database, {
      sharedRuntime: true,
      adminToken: "operator-secret",
    });

    const authenticated = await app.request("/api/auth/session", {
      headers: { authorization: "Bearer operator-secret" },
    });
    const operatorCookie = authenticated.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(operatorCookie).toContain("oomol_connect_admin_session=");
    expect((await app.request("/api/tenant/context", { headers: { cookie: operatorCookie } })).status).toBe(401);

    const selected = await app.request(`/api/operator/tenants/${tenantA}/session`, {
      method: "POST",
      headers: { cookie: operatorCookie },
    });
    expect(selected.status, await selected.clone().text()).toBe(200);
    const tenantCookie = selected.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(tenantCookie).toContain("oomol_connect_operator_tenant_session=");
    expect(tenantCookie).not.toContain("operator-secret");
    const scopedCookies = `${operatorCookie}; ${tenantCookie}`;

    const session = await app.request("/api/auth/session", { headers: { cookie: scopedCookies } });
    await expect(session.json()).resolves.toEqual({
      adminAuthConfigured: true,
      authenticated: true,
      sharedRuntime: true,
      tenantId: tenantA,
    });
    const context = await app.request("/api/tenant/context", { headers: { cookie: scopedCookies } });
    await expect(context.json()).resolves.toEqual({ tenantId: tenantA, capability: "tenant-admin" });
    expect((await app.request("/api/tenant/providers", { headers: { cookie: scopedCookies } })).status).toBe(200);
    expect((await app.request("/api/tenant/actions", { headers: { cookie: scopedCookies } })).status).toBe(200);
    expect((await app.request("/api/tenant/runtime-tokens", { headers: { cookie: scopedCookies } })).status).toBe(200);
    expect((await app.request("/v1/principal", { headers: { cookie: scopedCookies } })).status).toBe(401);
    const tamperedCookies = `${operatorCookie}; ${tenantCookie.replace(String(tenantA), String(tenantB))}`;
    expect((await app.request("/api/tenant/context", { headers: { cookie: tamperedCookies } })).status).toBe(401);

    const exited = await app.request("/api/operator/tenant-session", {
      method: "DELETE",
      headers: { cookie: scopedCookies },
    });
    expect(exited.status).toBe(200);
    expect(exited.headers.get("set-cookie")).toContain("oomol_connect_operator_tenant_session=;");
    expect((await app.request("/api/operator/tenants", { headers: { cookie: operatorCookie } })).status).toBe(200);
    expect((await app.request("/api/tenant/context", { headers: { cookie: operatorCookie } })).status).toBe(401);

    const { app: openOperatorApp } = await createSharedTestApp(directory, database, { sharedRuntime: true });
    const openSelection = await openOperatorApp.request(`/api/operator/tenants/${tenantA}/session`, {
      method: "POST",
    });
    const openTenantCookie = openSelection.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(openSelection.status).toBe(200);
    expect(
      (await openOperatorApp.request("/api/tenant/context", { headers: { cookie: openTenantCookie } })).status,
    ).toBe(200);

    database.close();
  });

  it("isolates same-alias connections, grants, OAuth, runs, idempotency, and transit files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "open-connector-tenant-"));
    temporaryDirectories.push(directory);
    const database = new SqliteRuntimeDatabase(join(directory, "runtime.sqlite"));
    const credentials = new TenantCredentialService(database.tenantCredentialStore);
    await credentials.createTenant({ id: tenantA, displayName: "Tenant A", createdAt: new Date().toISOString() });
    await credentials.createTenant({ id: tenantB, displayName: "Tenant B", createdAt: new Date().toISOString() });

    const adminA = await credentials.issueAdminCredential(tenantA, "Control Center A");
    const adminB = await credentials.issueAdminCredential(tenantB, "Control Center B");
    await expect(credentials.resolveAdminCredential(adminA.credential)).resolves.toMatchObject({ tenantId: tenantA });
    await expect(credentials.resolveAdminCredential(adminB.credential)).resolves.toMatchObject({ tenantId: tenantB });

    const authApp = new Hono();
    authApp.use(
      "*",
      createLocalAuthMiddleware({
        hasTenantAdminCredentials: () => credentials.hasAdminCredentials(),
        tenantCredentials: credentials,
      }),
    );
    authApp.get("/api/tenant/context", (context) => context.json(readAuthenticatedPrincipal(context)));
    expect(
      (
        await authApp.request("/api/tenant/context", {
          headers: { "x-tenant-id": tenantA },
        })
      ).status,
    ).toBe(401);
    const authenticatedContext = await authApp.request("/api/tenant/context", {
      headers: { authorization: `Bearer ${adminA.credential}`, "x-tenant-id": tenantB },
    });
    await expect(authenticatedContext.json()).resolves.toMatchObject({ tenantId: tenantA, capability: "tenant-admin" });

    const connectionA = await database.connectionStore.set(
      "gmail",
      "default",
      apiCredential("a@example.test"),
      tenantA,
    );
    const connectionB = await database.connectionStore.set(
      "gmail",
      "default",
      apiCredential("b@example.test"),
      tenantB,
    );
    expect(connectionA.id).not.toBe(connectionB.id);
    await expect(database.connectionStore.list(tenantA)).resolves.toMatchObject([{ id: connectionA.id }]);
    await expect(database.connectionStore.list(tenantB)).resolves.toMatchObject([{ id: connectionB.id }]);
    await expect(database.connectionStore.get("gmail", "default", tenantA)).resolves.toMatchObject({
      id: connectionA.id,
    });
    await expect(database.connectionStore.get("gmail", "default", tenantB)).resolves.toMatchObject({
      id: connectionB.id,
    });
    await expect(database.connectionStore.updateCredential(connectionB, tenantA)).resolves.toBe(false);
    await expect(database.connectionStore.get("gmail", "default", tenantB)).resolves.toMatchObject({
      credential: { profile: { accountId: "b@example.test" } },
    });
    const tokens = new RuntimeTokenService(database.runtimeTokenStore, database.connectionStore);
    const tokenA = await tokens.createToken("runtime-a", tokenPolicy([connectionA.id]), tenantA);
    await expect(tokens.createToken("foreign", tokenPolicy([connectionB.id]), tenantA)).rejects.toBeInstanceOf(
      RuntimeTokenPolicyError,
    );
    await expect(tokens.resolveToken(tokenA.token)).resolves.toMatchObject({
      tenantId: tenantA,
      allowedConnections: [connectionA.id],
    });
    await expect(tokens.revokeToken(tokenA.record.id, tenantB)).resolves.toBe(false);
    await expect(tokens.resolveToken(tokenA.token)).resolves.toMatchObject({ tenantId: tenantA });

    await database.oauthStateStore.set({
      tenantId: tenantA,
      service: "gmail",
      connectionName: "default",
      state: "oauth-a",
      createdAt: new Date().toISOString(),
      sessionCorrelation: "test-session-correlation",
    });
    await database.oauthStateStore.set({
      tenantId: tenantB,
      service: "gmail",
      connectionName: "default",
      state: "oauth-b",
      createdAt: new Date().toISOString(),
      sessionCorrelation: "test-session-correlation",
    });
    await expect(database.oauthStateStore.take("oauth-a")).resolves.toMatchObject({ tenantId: tenantA });
    await expect(database.oauthStateStore.take("oauth-a")).resolves.toBeUndefined();
    await expect(database.oauthStateStore.take("oauth-b")).resolves.toMatchObject({ tenantId: tenantB });

    await database.runLogStore.add(run("run-a"), tenantA);
    await database.runLogStore.add(run("run-b"), tenantB);
    await expect(database.runLogStore.list({}, tenantA)).resolves.toMatchObject({ items: [{ id: "run-a" }] });
    await expect(database.runLogStore.get("run-b", tenantA)).resolves.toBeUndefined();
    await expect(database.runLogStore.list({}, tenantB)).resolves.toMatchObject({ items: [{ id: "run-b" }] });
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60000).toISOString();
    await expect(
      database.idempotencyStore.claim({
        tenantId: tenantA,
        keyHash: "same-key",
        requestHash: "a",
        claimId: "a",
        now,
        expiresAt,
      }),
    ).resolves.toEqual({ kind: "acquired" });
    await expect(
      database.idempotencyStore.claim({
        tenantId: tenantB,
        keyHash: "same-key",
        requestHash: "b",
        claimId: "b",
        now,
        expiresAt,
      }),
    ).resolves.toEqual({ kind: "acquired" });
    await database.idempotencyStore.complete({
      tenantId: tenantA,
      keyHash: "same-key",
      requestHash: "a",
      claimId: "a",
      response: success("tenant-a"),
      expiresAt,
    });
    await expect(
      database.idempotencyStore.claim({
        tenantId: tenantA,
        keyHash: "same-key",
        requestHash: "a",
        claimId: "a2",
        now,
        expiresAt,
      }),
    ).resolves.toMatchObject({ kind: "completed", response: { body: { data: "tenant-a" } } });
    await expect(
      database.idempotencyStore.claim({
        tenantId: tenantB,
        keyHash: "same-key",
        requestHash: "b",
        claimId: "b2",
        now,
        expiresAt,
      }),
    ).resolves.toEqual({ kind: "in_progress" });

    const transit = new TransitFileService({
      rootDir: join(directory, "transit"),
      publicOrigin: "https://connector.example.test",
      ttlSeconds: 60,
      maxBytes: 1024,
    });
    const file = await transit.create(new File(["tenant-a"], "proof.txt"), tenantA);
    await expect(transit.read(file.fileId, tenantB)).rejects.toMatchObject({ code: "file_not_found" });
    await expect(transit.delete(file.fileId, tenantB)).rejects.toMatchObject({ code: "file_not_found" });
    await expect(transit.read(file.fileId, tenantA)).resolves.toMatchObject({ name: "proof.txt" });

    const catalog = createCatalogStore([gmailProvider], { executableActionIds: [gmailProvider.actions[0]!.id] });
    const providerLoader = new TestProviderLoader();
    const actionRunner = new ActionRunner({
      catalog,
      providerLoader,
      connections: new ConnectionService({ catalog, providerLoader, store: database.connectionStore }),
      runs: database.runLogStore,
    });
    await expect(
      actionRunner.run({ tenantId: tenantA, actionId: "gmail.account", input: {}, caller: "http" }),
    ).resolves.toMatchObject({ result: { ok: true, output: { accountId: "a@example.test" } } });
    await expect(
      actionRunner.run({ tenantId: tenantB, actionId: "gmail.account", input: {}, caller: "http" }),
    ).resolves.toMatchObject({ result: { ok: true, output: { accountId: "b@example.test" } } });
    database.close();
  });

  it("stages public OAuth callbacks and completes only for the initiating tenant session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "open-connector-oauth-session-"));
    temporaryDirectories.push(directory);
    const secretCodec = new AesGcmSecretCodec("oauth-session-test-key");
    const database = new SqliteRuntimeDatabase(join(directory, "runtime.sqlite"), { secretCodec });
    const credentials = new TenantCredentialService(database.tenantCredentialStore);
    await credentials.createTenant({ id: tenantA, displayName: "Tenant A", createdAt: new Date().toISOString() });
    await credentials.createTenant({ id: tenantB, displayName: "Tenant B", createdAt: new Date().toISOString() });
    const adminA = await credentials.issueAdminCredential(tenantA, "Control Center A");
    const adminB = await credentials.issueAdminCredential(tenantB, "Control Center B");
    const tokens = new RuntimeTokenService(database.runtimeTokenStore, database.connectionStore);
    await tokens.createToken("runtime-a", undefined, tenantA);
    await database.oauthClientConfigStore.set({
      service: "gmail",
      clientId: "client-id",
      clientSecret: "client-secret",
      extra: {},
      secretExtra: {},
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ access_token: "tenant-a-access", token_type: "Bearer" })),
    );
    const catalog = createCatalogStore([gmailOAuthProvider], {
      executableActionIds: [gmailOAuthProvider.actions[0]!.id],
    });
    const { app } = await createConnectApp({
      catalog,
      providerLoader: new TestProviderLoader(),
      runtimeDatabase: database,
      transitFiles: new TransitFileService({
        rootDir: join(directory, "transit"),
        publicOrigin: "https://connector.example.test",
        ttlSeconds: 60,
        maxBytes: 1024,
      }),
      publicOrigin: "https://connector.example.test",
      secretCodec,
      sharedRuntime: true,
      allowedCustomOAuth: [],
      allowedOAuthReturnUrlOrigins: ["https://control-center.example.test"],
    });
    const returnUrl = "https://control-center.example.test/oauth/complete";
    const start = await app.request("/api/tenant/oauth/authorizations", {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminA.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        service: "gmail",
        connectionName: "default",
        returnUrl,
        sessionCorrelation: "control-center-session-a",
      }),
    });
    expect(start.status, await start.clone().text()).toBe(200);
    const started = (await start.json()) as { state: string };
    const callback = await app.request(`/oauth/callback?state=${started.state}&code=provider-code`);
    expect(callback.status).toBe(200);
    await expect(database.connectionStore.get("gmail", "default", tenantA)).resolves.toBeUndefined();
    const html = await callback.text();
    const href = html.match(/href="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
    const completionCapability = href ? new URL(href).searchParams.get("oauthCompletion") : undefined;
    expect(completionCapability).toBeTruthy();

    const complete = async (credential: string, sessionCorrelation: string): Promise<Response> =>
      await app.request("/api/tenant/oauth/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        body: JSON.stringify({ completionCapability, sessionCorrelation }),
      });
    expect((await complete(adminB.credential, "control-center-session-a")).status).toBe(400);
    expect((await complete(adminA.credential, "control-center-session-b")).status).toBe(400);
    expect((await complete(adminA.credential, "control-center-session-a")).status).toBe(200);
    expect((await complete(adminA.credential, "control-center-session-a")).status).toBe(400);
    await expect(database.connectionStore.get("gmail", "default", tenantA)).resolves.toMatchObject({
      credential: { accessToken: "tenant-a-access" },
    });
    await expect(database.connectionStore.get("gmail", "default", tenantB)).resolves.toBeUndefined();

    const consoleReturnUrl = "http://localhost/console/oauth-complete?flow=flow-a&service=gmail";
    const consoleStart = await app.request("/api/tenant/oauth/authorizations", {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminA.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        service: "gmail",
        connectionName: "console",
        returnUrl: consoleReturnUrl,
        sessionCorrelation: "console-session-a",
      }),
    });
    expect(consoleStart.status, await consoleStart.clone().text()).toBe(200);
    const consoleState = ((await consoleStart.json()) as { state: string }).state;
    const consoleCallback = await app.request(`/oauth/callback?state=${consoleState}&code=console-code`);
    const consoleHtml = await consoleCallback.text();
    expect(consoleHtml).toContain("window.location.replace");
    expect(consoleHtml).not.toContain("new BroadcastChannel");
    const redirectValue = consoleHtml.match(/window\.location\.replace\(("[^"]+")\)/)?.[1];
    const consoleCompletionUrl = redirectValue ? new URL(JSON.parse(redirectValue) as string) : undefined;
    expect(consoleCompletionUrl?.pathname).toBe("/console/oauth-complete");
    const consoleCapability = consoleCompletionUrl?.searchParams.get("oauthCompletion");
    const consoleComplete = await app.request("/api/tenant/oauth/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${adminA.credential}`, "content-type": "application/json" },
      body: JSON.stringify({
        completionCapability: consoleCapability,
        sessionCorrelation: "console-session-a",
      }),
    });
    expect(consoleComplete.status, await consoleComplete.clone().text()).toBe(200);
    await expect(database.connectionStore.get("gmail", "console", tenantA)).resolves.toBeDefined();

    const cancelledStart = await app.request("/api/tenant/oauth/authorizations", {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminA.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        service: "gmail",
        connectionName: "cancelled",
        returnUrl: consoleReturnUrl,
        sessionCorrelation: "cancelled-session-a",
      }),
    });
    const cancelledState = ((await cancelledStart.json()) as { state: string }).state;
    const cancelledCallback = await app.request(`/oauth/callback?state=${cancelledState}&error=access_denied`);
    const cancelledHtml = await cancelledCallback.text();
    expect(cancelledHtml).toContain("window.location.replace");
    expect(cancelledHtml).toContain("oauthError");
    database.close();
  });
});

interface SharedTestAppOptions {
  sharedRuntime: boolean;
  adminToken?: string;
  runtimeToken?: string;
  verifyRuntimeJwt?: (token: string) => Promise<
    | {
        kind: "tenant";
        capability: "runtime";
        tenantId: typeof tenantA;
        runtimeTokenId: string;
      }
    | undefined
  >;
}

async function createSharedTestApp(
  directory: string,
  database: SqliteRuntimeDatabase,
  options: SharedTestAppOptions,
): Promise<ConnectApp> {
  const catalog = createCatalogStore([gmailProvider], { executableActionIds: [gmailProvider.actions[0]!.id] });
  return await createConnectApp({
    catalog,
    providerLoader: new TestProviderLoader(),
    runtimeDatabase: database,
    transitFiles: new TransitFileService({
      rootDir: join(directory, "transit"),
      publicOrigin: "https://connector.example.test",
      ttlSeconds: 60,
      maxBytes: 1024,
    }),
    publicOrigin: "https://connector.example.test",
    secretCodec: new AesGcmSecretCodec("tenant-isolation-test-key"),
    sharedRuntime: options.sharedRuntime,
    adminToken: options.adminToken,
    runtimeToken: options.runtimeToken,
    verifyRuntimeJwt: options.verifyRuntimeJwt,
  });
}

const gmailProvider: ProviderDefinition = {
  service: "gmail",
  displayName: "Gmail",
  categories: ["Communication"],
  authTypes: ["api_key"],
  auth: [{ type: "api_key" }],
  actions: [
    {
      id: "gmail.account",
      service: "gmail",
      name: "account",
      description: "Return the connected account.",
      requiredScopes: [],
      providerPermissions: [],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    },
  ],
};

const gmailOAuthProvider: ProviderDefinition = {
  ...gmailProvider,
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://accounts.example.test/oauth/authorize",
      tokenUrl: "https://accounts.example.test/oauth/token",
      scopes: [],
      tokenEndpointAuthMethod: "client_secret_post",
    },
  ],
};
class TestProviderLoader implements IProviderLoader {
  async loadActionExecutor(): Promise<ActionExecutor> {
    return async (_input, context) => {
      const credential = await context.getCredential("gmail");
      return {
        ok: true,
        output: { accountId: credential?.authType === "no_auth" ? undefined : credential?.profile.accountId },
      };
    };
  }

  async loadProxyExecutor(): Promise<undefined> {
    return undefined;
  }

  async loadCredentialValidators(): Promise<undefined> {
    return undefined;
  }
}

function apiCredential(account: string) {
  return {
    authType: "api_key" as const,
    apiKey: `secret-${account}`,
    values: { apiKey: `secret-${account}` },
    profile: { accountId: account, displayName: account, grantedScopes: [] },
    metadata: {},
  };
}

function tokenPolicy(allowedConnections: string[]) {
  return {
    allowedActions: ["gmail.*"],
    blockedActions: [],
    allowedProxies: [],
    allowedConnections,
  };
}

function run(id: string): RunLog {
  return {
    id,
    service: "gmail",
    actionId: "gmail.list_messages",
    caller: "http",
    startedAt: "2026-08-21T00:00:00.000Z",
    completedAt: "2026-08-21T00:00:01.000Z",
    durationMs: 1000,
    ok: true,
  };
}

function success(data: unknown): RuntimeActionHttpResult {
  return { status: 200, body: { success: true, message: "OK", data, meta: {} } };
}
