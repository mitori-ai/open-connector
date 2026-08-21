import type { ActionExecutor, ProviderDefinition } from "../../core/types.ts";
import type { IProviderLoader } from "../../providers/provider-loader.ts";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCatalogStore } from "../../catalog-store.ts";
import { compatibilityTenantId } from "../../core/tenant.ts";
import { parseTenantId } from "../../core/tenant.ts";
import { createConnectApp } from "../connect-app.ts";
import { TransitFileService } from "../files/transit-files.ts";
import { AesGcmSecretCodec } from "../secrets/secret-codec.ts";
import { migratePostgresDatabase } from "./postgres-migrations.ts";
import { PostgresRuntimeDatabase } from "./postgres-runtime-store.ts";
import { RuntimeTokenService } from "./runtime-token-service.ts";
import { TenantCredentialService } from "./tenant-credential-service.ts";
const testPostgresUrl = process.env.TEST_POSTGRES_URL;
const postgresSecretCodecKey = "postgres-acceptance-key";
describe.skipIf(!testPostgresUrl)("PostgreSQL runtime integration", () => {
  const schemas: string[] = [];
  let adminPool: Pool;
  let runtimeUrl: string;
  let first: PostgresRuntimeDatabase;
  let second: PostgresRuntimeDatabase;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: testPostgresUrl });
    runtimeUrl = await createTestSchema("runtime");
    const pool = new Pool({ connectionString: runtimeUrl, max: 1 });
    try {
      await migratePostgresDatabase({ pool });
    } finally {
      await pool.end();
    }
  });
  beforeEach(async () => {
    first = await PostgresRuntimeDatabase.open(runtimeUrl, {
      poolMax: 2,
      secretCodec: new AesGcmSecretCodec(postgresSecretCodecKey),
    });
    second = await PostgresRuntimeDatabase.open(runtimeUrl, {
      poolMax: 2,
      secretCodec: new AesGcmSecretCodec(postgresSecretCodecKey),
    });
    await first.resetRuntimeData();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await first.close();
    await second.close();
  });

  afterAll(async () => {
    for (const schema of schemas) {
      await adminPool.query(`drop schema ${schema} cascade`);
    }
    await adminPool.end();
  });

  it("serializes concurrent migration runners across PostgreSQL sessions", async () => {
    const url = await createTestSchema("migrations");
    const firstPool = new Pool({ connectionString: url, max: 1 });
    const secondPool = new Pool({ connectionString: url, max: 1 });
    try {
      await Promise.all([migratePostgresDatabase({ pool: firstPool }), migratePostgresDatabase({ pool: secondPool })]);
      const result = await firstPool.query<{
        name: string;
      }>("select name from runtime_migrations order by name");
      expect(result.rows.map((row) => row.name)).toEqual(
        expect.arrayContaining(["0010_runtime.sql", "0011_runtime_token_connection_scope.sql"]),
      );
    } finally {
      await firstPool.end();
      await secondPool.end();
    }
  });

  it("atomically consumes OAuth state across database instances", async () => {
    await first.oauthStateStore.set({
      service: "gmail",
      state: "state-1",
      createdAt: "2026-06-30T00:00:00.000Z",
      tenantId: compatibilityTenantId,
      sessionCorrelation: "test-session-correlation",
    });
    const results = await Promise.all([first.oauthStateStore.take("state-1"), second.oauthStateStore.take("state-1")]);
    expect(results.filter((result) => result !== undefined)).toHaveLength(1);
  });

  it("atomically claims idempotency keys across database instances", async () => {
    const claim = {
      keyHash: "key-hash",
      requestHash: "request-hash",
      now: "2026-06-30T00:00:00.000Z",
      expiresAt: "2026-07-01T00:00:00.000Z",
    };
    const results = await Promise.all([
      first.idempotencyStore.claim({ ...claim, claimId: "claim-1", tenantId: compatibilityTenantId }),
      second.idempotencyStore.claim({ ...claim, claimId: "claim-2", tenantId: compatibilityTenantId }),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(["acquired", "in_progress"]);
  });

  it("rejects stale connection revisions across database instances", async () => {
    const credential = {
      authType: "api_key" as const,
      apiKey: "github-token",
      values: { apiKey: "github-token" },
      profile: {
        accountId: "github:octocat",
        displayName: "octocat",
        grantedScopes: [],
      },
      metadata: {},
    };
    const created = await first.connectionStore.set("github", "default", credential, compatibilityTenantId);
    const updated = await second.connectionStore.set(
      "github",
      "default",
      {
        ...credential,
        apiKey: "updated-token",
      },
      compatibilityTenantId,
    );
    await expect(
      first.connectionStore.updateCredential(
        {
          ...created,
          credential: { ...credential, apiKey: "stale-token" },
        },
        compatibilityTenantId,
      ),
    ).resolves.toBe(false);
    expect(updated.id).toBe(created.id);
  });
  it("isolates two tenant clients through one PostgreSQL-backed server", async () => {
    const tenantA = parseTenantId("tenant-a");
    const tenantB = parseTenantId("tenant-b");
    const credentials = new TenantCredentialService(first.tenantCredentialStore);
    await credentials.createTenant({ id: tenantA, displayName: "Tenant A", createdAt: new Date().toISOString() });
    await credentials.createTenant({ id: tenantB, displayName: "Tenant B", createdAt: new Date().toISOString() });
    const adminA = await credentials.issueAdminCredential(tenantA, "Control Center A");
    const adminB = await credentials.issueAdminCredential(tenantB, "Control Center B");
    await new RuntimeTokenService(first.runtimeTokenStore, first.connectionStore).createToken(
      "startup",
      undefined,
      tenantA,
    );
    await first.oauthClientConfigStore.set({
      service: "gmail",
      clientId: "client-id",
      clientSecret: "client-secret",
      extra: {},
      secretExtra: {},
    });
    const directory = await mkdtemp(join(tmpdir(), "open-connector-postgres-acceptance-"));
    const providerLoader = new AcceptanceProviderLoader();
    const catalog = createCatalogStore([gmailProvider], {
      executableActionIds: gmailProvider.actions.map((action) => action.id),
    });
    const { app } = await createConnectApp({
      catalog,
      providerLoader,
      runtimeDatabase: first,
      transitFiles: new TransitFileService({
        rootDir: join(directory, "transit"),
        publicOrigin: "https://connector.example.test",
        ttlSeconds: 60,
        maxBytes: 1024,
      }),
      publicOrigin: "https://connector.example.test",
      secretCodec: new AesGcmSecretCodec(postgresSecretCodecKey),
      sharedRuntime: true,
      allowedCustomOAuth: [],
      allowedOAuthReturnUrlOrigins: ["https://control-center.example.test"],
    });
    try {
      const adminHeaders = (credential: string): Record<string, string> => ({
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      });
      const connect = async (
        credential: string,
        apiKey: string,
        connectionName = "default",
      ): Promise<{ id: string }> => {
        const response = await app.request("/api/tenant/connections/gmail", {
          method: "PUT",
          headers: adminHeaders(credential),
          body: JSON.stringify({ authType: "api_key", connectionName, values: { apiKey } }),
        });
        expect(response.status).toBe(200);
        return (await response.json()) as { id: string };
      };
      const connectionA = await connect(adminA.credential, "a@example.test");
      const connectionB = await connect(adminB.credential, "b@example.test");
      expect(connectionA.id).not.toBe(connectionB.id);
      const connectionsA = await app.request("/api/tenant/connections", {
        headers: adminHeaders(adminA.credential),
      });
      const connectionsB = await app.request("/api/tenant/connections", {
        headers: adminHeaders(adminB.credential),
      });
      const connectionsAText = await connectionsA.text();
      const connectionsBText = await connectionsB.text();
      expect(connectionsAText).toContain(connectionA.id);
      expect(connectionsAText).not.toContain(connectionB.id);
      expect(connectionsBText).toContain(connectionB.id);
      expect(connectionsBText).not.toContain(connectionA.id);

      const issueRuntime = async (credential: string, connectionId: string): Promise<{ token: string; id: string }> => {
        const response = await app.request("/api/tenant/runtime-tokens", {
          method: "POST",
          headers: adminHeaders(credential),
          body: JSON.stringify({
            name: "Control Center runtime",
            allowedActions: ["gmail.*"],
            blockedActions: [],
            allowedProxies: [],
            allowedConnections: [connectionId],
          }),
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as { token: string; record: { id: string } };
        return { token: body.token, id: body.record.id };
      };
      const runtimeA = await issueRuntime(adminA.credential, connectionA.id);
      const runtimeB = await issueRuntime(adminB.credential, connectionB.id);
      const foreignGrant = await app.request("/api/tenant/runtime-tokens", {
        method: "POST",
        headers: adminHeaders(adminA.credential),
        body: JSON.stringify({
          name: "foreign",
          allowedActions: ["gmail.*"],
          blockedActions: [],
          allowedProxies: [],
          allowedConnections: [connectionB.id],
        }),
      });
      expect(foreignGrant.status).toBe(400);

      const run = async (token: string, idempotencyKey?: string): Promise<Response> =>
        await app.request("/v1/actions/gmail.account", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
          },
          body: JSON.stringify({ input: {}, connectionName: "default" }),
        });
      const actionA = await run(runtimeA.token, "same-key");
      const actionB = await run(runtimeB.token, "same-key");
      expect(actionA.status).toBe(200);
      expect(actionB.status).toBe(200);
      const actionABody = (await actionA.json()) as { data: { accountId: string }; meta: { executionId: string } };
      const actionBBody = (await actionB.json()) as { data: { accountId: string }; meta: { executionId: string } };
      expect(actionABody.data.accountId).toBe("a@example.test");
      expect(actionBBody.data.accountId).toBe("b@example.test");
      expect((await run(runtimeA.token, "same-key")).status).toBe(200);
      const conflictingIdempotencyRequest = await app.request("/v1/actions/gmail.account", {
        method: "POST",
        headers: {
          authorization: `Bearer ${runtimeA.token}`,
          "content-type": "application/json",
          "idempotency-key": "same-key",
        },
        body: JSON.stringify({ input: { changed: true }, connectionName: "default" }),
      });
      expect(conflictingIdempotencyRequest.status).toBe(409);

      const discoveryA = await app.request("/v1/apps", {
        headers: { authorization: `Bearer ${runtimeA.token}` },
      });
      expect(discoveryA.status).toBe(200);
      const discoveryAText = await discoveryA.text();
      expect(discoveryAText).toContain(connectionA.id);
      expect(discoveryAText).not.toContain(connectionB.id);

      const tenantAForm = new FormData();
      tenantAForm.set("file", new File(["tenant-a-transit"], "tenant-a.txt", { type: "text/plain" }));
      const transitUploadA = await app.request("/api/files", {
        method: "POST",
        headers: { authorization: `Bearer ${adminA.credential}` },
        body: tenantAForm,
      });
      expect(transitUploadA.status).toBe(200);
      const { fileId: tenantAFileId } = (await transitUploadA.json()) as { fileId: string };
      const tenantATransit = await app.request(`/api/files/${tenantAFileId}`, {
        headers: { authorization: `Bearer ${adminA.credential}` },
      });
      expect(tenantATransit.status).toBe(200);
      await expect(tenantATransit.text()).resolves.toBe("tenant-a-transit");
      const foreignTransitRead = await app.request(`/api/files/${tenantAFileId}`, {
        headers: { authorization: `Bearer ${adminB.credential}` },
      });
      expect(foreignTransitRead.status).toBe(404);
      const foreignTransitDelete = await app.request(`/api/files/${tenantAFileId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${adminB.credential}` },
      });
      expect(foreignTransitDelete.status).toBe(404);
      expect(
        (
          await app.request(`/api/files/${tenantAFileId}`, {
            headers: { authorization: `Bearer ${adminA.credential}` },
          })
        ).status,
      ).toBe(200);

      const proxyA = await app.request("/v1/proxy/gmail", {
        method: "POST",
        headers: { authorization: `Bearer ${runtimeA.token}`, "content-type": "application/json" },
        body: JSON.stringify({ method: "GET", path: "/me" }),
      });
      expect(proxyA.status).toBe(403);

      const fetcher: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        const headers = new Headers(request.headers);
        headers.set("authorization", `Bearer ${runtimeA.token}`);
        return await app.fetch(new Request(request, { headers }));
      };
      const transport = new StreamableHTTPClientTransport(new URL("https://connector.example.test/mcp"), {
        fetch: fetcher,
      });
      const client = new Client({ name: "postgres-acceptance", version: "1.0.0" });
      try {
        await client.connect(transport);
        const result = await client.callTool({
          name: "execute_action",
          arguments: { actionId: "gmail.account", input: {}, connectionName: "default" },
        });
        expect(JSON.stringify(result)).toContain("a@example.test");
        expect(JSON.stringify(result)).not.toContain("b@example.test");
      } finally {
        await client.close();
      }

      const storedConnectionA = await first.connectionStore.get("gmail", "default", tenantA);
      const storedConnectionB = await first.connectionStore.get("gmail", "default", tenantB);
      expect(storedConnectionA).toBeDefined();
      expect(storedConnectionB).toBeDefined();
      if (
        !storedConnectionA ||
        storedConnectionA.credential.authType === "no_auth" ||
        !storedConnectionB ||
        storedConnectionB.credential.authType === "no_auth"
      ) {
        throw new Error("acceptance connections must contain credential profiles");
      }
      const expiredOAuthCredential = (refreshToken: string, profile: typeof storedConnectionA.credential.profile) => ({
        authType: "oauth2" as const,
        accessToken: "expired-token",
        refreshToken,
        tokenType: "Bearer",
        expiresAt: "2020-01-01T00:00:00.000Z",
        profile,
        metadata: { expires_in: 3600 },
      });
      expect(
        await first.connectionStore.updateCredential(
          {
            ...storedConnectionA,
            credential: expiredOAuthCredential("tenant-a-refresh-token", storedConnectionA.credential.profile),
          },
          tenantA,
        ),
      ).toBe(true);
      expect(
        await first.connectionStore.updateCredential(
          {
            ...storedConnectionB,
            credential: expiredOAuthCredential("tenant-b-refresh-token", storedConnectionB.credential.profile),
          },
          tenantB,
        ),
      ).toBe(true);
      const refreshedTokens: string[] = [];
      const refreshEndpoint = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const refreshToken = new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
        refreshedTokens.push(refreshToken);
        return Response.json({
          access_token: refreshToken.replace("refresh", "refreshed"),
          token_type: "Bearer",
          expires_in: 3600,
        });
      });
      vi.stubGlobal("fetch", refreshEndpoint);
      const concurrentRefreshRuns = await Promise.all([
        run(runtimeA.token),
        run(runtimeA.token),
        run(runtimeB.token),
        run(runtimeB.token),
      ]);
      expect(concurrentRefreshRuns.map((response) => response.status)).toEqual([200, 200, 200, 200]);
      expect(refreshEndpoint).toHaveBeenCalledTimes(2);
      expect(refreshedTokens.sort()).toEqual(["tenant-a-refresh-token", "tenant-b-refresh-token"]);
      await expect(first.connectionStore.get("gmail", "default", tenantA)).resolves.toMatchObject({
        credential: { accessToken: "tenant-a-refreshed-token" },
      });
      await expect(first.connectionStore.get("gmail", "default", tenantB)).resolves.toMatchObject({
        credential: { accessToken: "tenant-b-refreshed-token" },
      });
      vi.unstubAllGlobals();

      const cancellation = new AbortController();
      const cancelledRequest = new Request("https://connector.example.test/v1/actions/gmail.wait", {
        method: "POST",
        headers: {
          authorization: `Bearer ${runtimeA.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: {}, connectionName: "default" }),
        signal: cancellation.signal,
      });
      const cancelledResponse = app.fetch(cancelledRequest);
      await providerLoader.waitExecutionStarted;
      cancellation.abort();
      expect((await cancelledResponse).status).toBe(400);
      expect((await run(runtimeB.token)).status).toBe(200);

      const connectionAOther = await connect(adminA.credential, "a-other@example.test", "other");
      const updatedConnectionAOther = await connect(adminA.credential, "a-other-updated@example.test", "other");
      expect(updatedConnectionAOther.id).toBe(connectionAOther.id);
      const updateRuntimeGrant = async (allowedConnections: string[]): Promise<Response> =>
        await app.request(`/api/tenant/runtime-tokens/${runtimeA.id}`, {
          method: "PUT",
          headers: adminHeaders(adminA.credential),
          body: JSON.stringify({
            allowedActions: ["gmail.*"],
            blockedActions: [],
            allowedProxies: [],
            allowedConnections,
          }),
        });
      expect((await updateRuntimeGrant([connectionAOther.id])).status).toBe(200);
      expect((await run(runtimeA.token)).status).toBe(403);
      expect((await run(runtimeB.token)).status).toBe(200);
      const grantedOther = await app.request("/v1/actions/gmail.account", {
        method: "POST",
        headers: {
          authorization: `Bearer ${runtimeA.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: {}, connectionName: "other" }),
      });
      expect(grantedOther.status).toBe(200);
      expect(await grantedOther.text()).toContain("a-other-updated@example.test");
      expect((await updateRuntimeGrant([connectionA.id])).status).toBe(200);
      expect((await run(runtimeA.token)).status).toBe(200);
      const deleteOther = await app.request("/api/tenant/connections/gmail", {
        method: "DELETE",
        headers: adminHeaders(adminA.credential),
        body: JSON.stringify({ connectionName: "other" }),
      });
      expect(deleteOther.status).toBe(200);
      await expect(first.connectionStore.get("gmail", "other", tenantA)).resolves.toBeUndefined();
      await expect(first.connectionStore.get("gmail", "default", tenantB)).resolves.toBeDefined();

      const runsA = await app.request("/api/tenant/runs", { headers: adminHeaders(adminA.credential) });
      const runsB = await app.request("/api/tenant/runs", { headers: adminHeaders(adminB.credential) });
      expect(runsA.status).toBe(200);
      expect(runsB.status).toBe(200);
      const runsAText = await runsA.text();
      const runsBText = await runsB.text();
      expect(runsAText).toContain("execution_cancelled");
      expect(runsAText).not.toContain("b@example.test");
      expect(runsBText).not.toContain("execution_cancelled");
      expect(runsBText).not.toContain("a@example.test");
      expect(
        (
          await app.request(`/api/tenant/runs/${actionABody.meta.executionId}`, {
            headers: adminHeaders(adminA.credential),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await app.request(`/api/tenant/runs/${actionABody.meta.executionId}`, {
            headers: adminHeaders(adminB.credential),
          })
        ).status,
      ).toBe(404);
      const revokeA = await app.request(`/api/tenant/runtime-tokens/${runtimeA.id}`, {
        method: "DELETE",
        headers: adminHeaders(adminA.credential),
      });
      expect(revokeA.status).toBe(200);
      expect((await run(runtimeA.token)).status).toBe(401);
      expect((await run(runtimeB.token)).status).toBe(200);

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ access_token: "tenant-a-oauth", token_type: "Bearer" })),
      );
      const oauthStart = await app.request("/api/tenant/oauth/authorizations", {
        method: "POST",
        headers: adminHeaders(adminA.credential),
        body: JSON.stringify({
          service: "gmail",
          connectionName: "oauth",
          returnUrl: "https://control-center.example.test/oauth/complete",
          sessionCorrelation: "control-center-session-a",
        }),
      });
      expect(oauthStart.status).toBe(200);
      const { state } = (await oauthStart.json()) as { state: string };
      const callback = await app.request(`/oauth/callback?state=${state}&code=provider-code`);
      expect(callback.status).toBe(200);
      const href = (await callback.text()).match(/href="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
      const completionCapability = href ? new URL(href).searchParams.get("oauthCompletion") : undefined;
      expect(completionCapability).toBeTruthy();
      const completeOAuth = async (credential: string, sessionCorrelation: string): Promise<Response> =>
        await app.request("/api/tenant/oauth/completions", {
          method: "POST",
          headers: adminHeaders(credential),
          body: JSON.stringify({ completionCapability, sessionCorrelation }),
        });
      await expect(first.connectionStore.get("gmail", "oauth", tenantA)).resolves.toBeUndefined();
      expect((await completeOAuth(adminB.credential, "control-center-session-a")).status).toBe(400);
      expect((await completeOAuth(adminA.credential, "control-center-session-b")).status).toBe(400);
      expect((await completeOAuth(adminA.credential, "control-center-session-a")).status).toBe(200);
      expect((await completeOAuth(adminA.credential, "control-center-session-a")).status).toBe(400);
      await expect(first.connectionStore.get("gmail", "oauth", tenantA)).resolves.toMatchObject({
        credential: { accessToken: "tenant-a-oauth" },
      });
      await expect(first.connectionStore.get("gmail", "oauth", tenantB)).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  async function createTestSchema(label: string): Promise<string> {
    const schema = `open_connector_${label}_${randomUUID().replaceAll("-", "")}`;
    await adminPool.query(`create schema ${schema}`);
    schemas.push(schema);
    const url = new URL(testPostgresUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    return url.toString();
  }
});

const gmailProvider: ProviderDefinition = {
  service: "gmail",
  displayName: "Gmail",
  categories: ["Communication"],
  authTypes: ["api_key", "oauth2"],
  auth: [
    { type: "api_key" },
    {
      type: "oauth2",
      authorizationUrl: "https://accounts.example.test/oauth/authorize",
      tokenUrl: "https://accounts.example.test/oauth/token",
      scopes: [],
      tokenEndpointAuthMethod: "client_secret_post",
    },
  ],
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
    {
      id: "gmail.wait",
      service: "gmail",
      name: "wait",
      description: "Wait until the caller cancels the request.",
      requiredScopes: [],
      providerPermissions: [],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    },
  ],
};

class AcceptanceProviderLoader implements IProviderLoader {
  private markWaitExecutionStarted: (() => void) | undefined;
  readonly waitExecutionStarted = new Promise<void>((resolve) => {
    this.markWaitExecutionStarted = resolve;
  });

  async loadActionExecutor(_service: string, actionId: string): Promise<ActionExecutor> {
    if (actionId === "gmail.wait") {
      return async (_input, context) => {
        this.markWaitExecutionStarted?.();
        await new Promise<void>((_resolve, reject) => {
          context.signal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
        });
        return { ok: true, output: {} };
      };
    }
    return async (_input, context) => {
      const credential = await context.getCredential("gmail");
      return {
        ok: true,
        output: {
          accountId:
            credential?.authType === "api_key"
              ? credential.apiKey
              : credential?.authType === "no_auth"
                ? undefined
                : credential?.profile.accountId,
        },
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
