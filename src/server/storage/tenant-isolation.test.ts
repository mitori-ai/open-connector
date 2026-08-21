import type { ActionExecutor, ProviderDefinition } from "../../core/types.ts";
import type { IProviderLoader } from "../../providers/provider-loader.ts";
import type { RuntimeActionHttpResult } from "../api/runtime-api.ts";
import type { RunLog } from "./runtime-store.ts";

import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCatalogStore } from "../../catalog-store.ts";
import { ConnectionService } from "../../connection-service.ts";
import { parseTenantId } from "../../core/tenant.ts";
import { ActionRunner } from "../actions/action-runner.ts";
import { createLocalAuthMiddleware, readAuthenticatedPrincipal } from "../api/auth.ts";
import { TransitFileService } from "../files/transit-files.ts";
import { RuntimeTokenPolicyError, RuntimeTokenService } from "./runtime-token-service.ts";
import { SqliteRuntimeDatabase } from "./sqlite-runtime-store.ts";
import { TenantCredentialService } from "./tenant-credential-service.ts";

const tenantA = parseTenantId("tenant-a");
const tenantB = parseTenantId("tenant-b");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("shared runtime tenant isolation", () => {
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

    const tokens = new RuntimeTokenService(database.runtimeTokenStore, undefined, database.connectionStore);
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
    });
    await database.oauthStateStore.set({
      tenantId: tenantB,
      service: "gmail",
      connectionName: "default",
      state: "oauth-b",
      createdAt: new Date().toISOString(),
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
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
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
});

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
