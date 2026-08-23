import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseTenantId } from "../../core/tenant.ts";
import { migratePostgresDatabase } from "./postgres-migrations.ts";
import { importSqliteRuntimeToPostgresTenant } from "./sqlite-postgres-tenant-import.ts";
import { SqliteRuntimeDatabase } from "./sqlite-runtime-store.ts";

interface PGliteTestServer {
  database: PGlite;
  server: PGLiteSocketServer;
  url: string;
}

const tenantId = parseTenantId("cryofuture");

describe("SQLite to PostgreSQL tenant import with PGlite", () => {
  let testServer: PGliteTestServer;
  let pool: Pool;
  let directory: string;
  let sourcePath: string;

  beforeAll(async () => {
    testServer = await startPGliteTestServer();
    pool = new Pool({ connectionString: testServer.url, max: 1 });
    await migratePostgresDatabase({ pool });
    directory = await mkdtemp(join(tmpdir(), "open-connector-import-"));
  });

  beforeEach(async () => {
    await resetPostgresTarget(pool);
    sourcePath = join(directory, `${randomUUID()}.sqlite`);
    seedSqliteSource(sourcePath);
  });

  afterAll(async () => {
    await pool.end();
    await testServer.server.stop();
    await testServer.database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("validates with a rollback, then preserves IDs and opaque secret values", async () => {
    const dryRun = await importSqliteRuntimeToPostgresTenant({
      sourcePath,
      targetPool: pool,
      tenantId,
      tenantDisplayName: "Cryofuture",
      dryRun: true,
    });
    expect(dryRun).toMatchObject({ dryRun: true, tenantId, totalRows: 8 });
    await expect(pool.query("select id from tenants order by id")).resolves.toMatchObject({
      rows: [{ id: "local" }],
    });

    const imported = await importSqliteRuntimeToPostgresTenant({
      sourcePath,
      targetPool: pool,
      tenantId,
      tenantDisplayName: "Cryofuture",
    });
    expect(imported).toMatchObject({ dryRun: false, tenantId, totalRows: 8 });
    await expect(
      pool.query("select id, tenant_id, value from connections where service = 'github'"),
    ).resolves.toMatchObject({
      rows: [{ id: "stable-connection-uuid", tenant_id: "cryofuture", value: "encoded:connection-secret" }],
    });
    await expect(pool.query("select service, value from oauth_client_configs")).resolves.toMatchObject({
      rows: [{ service: "github", value: "encoded:oauth-config" }],
    });
    await expect(pool.query("select tenant_id, response_value from idempotency_records")).resolves.toMatchObject({
      rows: [{ tenant_id: "cryofuture", response_value: "encoded:idempotency-response" }],
    });
    await expect(pool.query("select id, display_name from tenants order by id")).resolves.toMatchObject({
      rows: [
        { id: "cryofuture", display_name: "Cryofuture" },
        { id: "local", display_name: "Compatibility tenant" },
      ],
    });
  });

  it("fails closed when repeated against the populated destination", async () => {
    await importSqliteRuntimeToPostgresTenant({
      sourcePath,
      targetPool: pool,
      tenantId,
      tenantDisplayName: "Cryofuture",
    });
    await expect(
      importSqliteRuntimeToPostgresTenant({
        sourcePath,
        targetPool: pool,
        tenantId,
        tenantDisplayName: "Cryofuture",
      }),
    ).rejects.toThrow("PostgreSQL destination is not empty");
  });

  it("rejects a source containing another tenant", async () => {
    const sqlite = new DatabaseSync(sourcePath);
    sqlite
      .prepare("insert into tenants (id, display_name, created_at) values (?, ?, ?)")
      .run("another-tenant", "Another tenant", new Date().toISOString());
    sqlite.close();

    await expect(
      importSqliteRuntimeToPostgresTenant({
        sourcePath,
        targetPool: pool,
        tenantId,
        tenantDisplayName: "Cryofuture",
      }),
    ).rejects.toThrow("contains non-compatibility tenants");
  });
});

const testPostgresUrl = process.env.TEST_POSTGRES_URL;
describe.skipIf(!testPostgresUrl)("SQLite to real PostgreSQL tenant import", () => {
  let adminPool: Pool;
  let runtimePool: Pool;
  let schema: string;
  let directory: string;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: testPostgresUrl });
    schema = `open_connector_import_${randomUUID().replaceAll("-", "")}`;
    await adminPool.query(`create schema ${schema}`);
    const runtimeUrl = new URL(testPostgresUrl!);
    runtimeUrl.searchParams.set("options", `-c search_path=${schema}`);
    runtimePool = new Pool({ connectionString: runtimeUrl.toString(), max: 1 });
    await migratePostgresDatabase({ pool: runtimePool });
    directory = await mkdtemp(join(tmpdir(), "open-connector-real-postgres-import-"));
  });

  afterAll(async () => {
    await runtimePool.end();
    await adminPool.query(`drop schema ${schema} cascade`);
    await adminPool.end();
    await rm(directory, { recursive: true, force: true });
  });

  it("commits a compatibility runtime into the explicit tenant", async () => {
    await resetPostgresTarget(runtimePool);
    const sourcePath = join(directory, "connect.sqlite");
    seedSqliteSource(sourcePath);
    await expect(
      importSqliteRuntimeToPostgresTenant({
        sourcePath,
        targetPool: runtimePool,
        tenantId,
        tenantDisplayName: "Cryofuture",
      }),
    ).resolves.toMatchObject({ tenantId, totalRows: 8 });
    await expect(runtimePool.query("select tenant_id, id from connections")).resolves.toMatchObject({
      rows: [{ tenant_id: "cryofuture", id: "stable-connection-uuid" }],
    });
  });

  it("rolls back all rows when a copied row violates a PostgreSQL constraint", async () => {
    await resetPostgresTarget(runtimePool);
    const sourcePath = join(directory, "invalid.sqlite");
    seedSqliteSource(sourcePath, "not-a-postgres-uuid");
    await expect(
      importSqliteRuntimeToPostgresTenant({
        sourcePath,
        targetPool: runtimePool,
        tenantId,
        tenantDisplayName: "Cryofuture",
      }),
    ).rejects.toThrow();
    await expect(runtimePool.query("select id from tenants order by id")).resolves.toMatchObject({
      rows: [{ id: "local" }],
    });
    await expect(runtimePool.query("select count(*)::int as count from connections")).resolves.toMatchObject({
      rows: [{ count: 0 }],
    });
  });
});

function seedSqliteSource(sourcePath: string, adminCredentialId: string = randomUUID()): void {
  new SqliteRuntimeDatabase(sourcePath).close();
  const sqlite = new DatabaseSync(sourcePath);
  const now = "2026-08-24T00:00:00.000Z";
  sqlite
    .prepare(
      "insert into tenant_admin_credentials (id, tenant_id, name, token_hash, created_at) values (?, 'local', ?, ?, ?)",
    )
    .run(adminCredentialId, "Admin", "admin-token-hash", now);
  sqlite
    .prepare(
      "insert into connections (id, revision, tenant_id, service, connection_name, value, updated_at) values (?, ?, 'local', ?, ?, ?, ?)",
    )
    .run("stable-connection-uuid", "stable-revision", "github", "default", "encoded:connection-secret", now);
  sqlite
    .prepare("insert into oauth_client_configs (service, value, updated_at) values (?, ?, ?)")
    .run("github", "encoded:oauth-config", now);
  sqlite
    .prepare("insert into oauth_states (state, tenant_id, value, created_at) values (?, 'local', ?, ?)")
    .run("oauth-state", "encoded:oauth-state", now);
  sqlite
    .prepare("insert into runtime_tokens (id, tenant_id, name, token_hash, created_at) values (?, 'local', ?, ?, ?)")
    .run("runtime-token-id", "Runtime", "runtime-token-hash", now);
  sqlite.prepare("insert into runtime_policy (id, value, updated_at) values (1, ?, ?)").run("{}", now);
  sqlite
    .prepare(
      "insert into runs (id, tenant_id, service, action_id, caller, started_at, completed_at, ok, value) values (?, 'local', ?, ?, ?, ?, ?, 1, ?)",
    )
    .run("run-id", "github", "github.user", "http", now, now, "{}");
  sqlite
    .prepare(
      "insert into idempotency_records (tenant_id, key_hash, claim_id, request_hash, state, response_value, created_at, expires_at) values ('local', ?, ?, ?, 'completed', ?, ?, ?)",
    )
    .run("key-hash", "claim-id", "request-hash", "encoded:idempotency-response", now, "2026-08-25T00:00:00.000Z");
  sqlite.close();
}

async function startPGliteTestServer(): Promise<PGliteTestServer> {
  const database = await PGlite.create();
  const server = new PGLiteSocketServer({ db: database, host: "127.0.0.1", port: 0, maxConnections: 10 });
  await server.start();
  const port = server.getServerConn().split(":").at(-1)!;
  return {
    database,
    server,
    url: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`,
  };
}

async function resetPostgresTarget(pool: Pool): Promise<void> {
  await pool.query(`
    truncate table tenant_admin_credentials, connections, oauth_client_configs, oauth_states,
      runtime_tokens, runtime_policy, runs, idempotency_records, tenants;
    insert into tenants (id, display_name, created_at) values ('local', 'Compatibility tenant', now());
  `);
}
