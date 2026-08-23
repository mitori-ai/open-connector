import type { TenantId } from "../../core/tenant.ts";
import type { Pool, PoolClient } from "pg";

import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { compatibilityTenantId } from "../../core/tenant.ts";
import { assertPostgresSchemaReady } from "./postgres-migrations.ts";

type SqliteRow = Record<string, unknown>;

const importLockNamespace = 1_326_382_671;
const importLockId = 2;

interface ImportTable {
  name: string;
  columns: string[];
  tenantScoped?: boolean;
}

const importTables: ImportTable[] = [
  {
    name: "tenant_admin_credentials",
    columns: ["id", "tenant_id", "name", "token_hash", "created_at", "last_used_at", "revoked_at"],
    tenantScoped: true,
  },
  {
    name: "connections",
    columns: ["id", "revision", "tenant_id", "service", "connection_name", "value", "updated_at"],
    tenantScoped: true,
  },
  { name: "oauth_client_configs", columns: ["service", "value", "updated_at"] },
  {
    name: "oauth_states",
    columns: ["state", "tenant_id", "value", "created_at"],
    tenantScoped: true,
  },
  {
    name: "runtime_tokens",
    columns: [
      "id",
      "tenant_id",
      "name",
      "token_hash",
      "allowed_actions",
      "blocked_actions",
      "allowed_proxies",
      "allowed_connections",
      "created_at",
      "last_used_at",
      "revoked_at",
    ],
    tenantScoped: true,
  },
  { name: "runtime_policy", columns: ["id", "value", "updated_at"] },
  {
    name: "runs",
    columns: ["id", "tenant_id", "service", "action_id", "caller", "started_at", "completed_at", "ok", "value"],
    tenantScoped: true,
  },
  {
    name: "idempotency_records",
    columns: [
      "tenant_id",
      "key_hash",
      "claim_id",
      "request_hash",
      "state",
      "response_value",
      "created_at",
      "expires_at",
    ],
    tenantScoped: true,
  },
];

export interface SqlitePostgresTenantImportOptions {
  sourcePath: string;
  targetPool: Pool;
  tenantId: TenantId;
  tenantDisplayName: string;
  dryRun?: boolean;
}

export interface SqlitePostgresTenantImportResult {
  dryRun: boolean;
  tenantId: TenantId;
  rowCounts: Record<string, number>;
  totalRows: number;
}

/**
 * Copy a current compatibility-tenant SQLite runtime into an otherwise empty PostgreSQL runtime.
 * Secret-bearing values are transferred as opaque encoded strings, so the destination must use
 * the same encryption key as the source.
 */
export async function importSqliteRuntimeToPostgresTenant(
  options: SqlitePostgresTenantImportOptions,
): Promise<SqlitePostgresTenantImportResult> {
  assertSourceFile(options.sourcePath);
  if (options.tenantId === compatibilityTenantId) {
    throw new Error("The destination tenant must not be the compatibility tenant `local`.");
  }
  const tenantDisplayName = options.tenantDisplayName.trim();
  if (!tenantDisplayName) {
    throw new Error("Tenant display name must not be empty.");
  }

  await assertPostgresSchemaReady(options.targetPool);
  const source = new DatabaseSync(options.sourcePath);
  let sourceTransactionOpen = false;
  try {
    source.exec("pragma foreign_keys = on; begin immediate; pragma query_only = on;");
    sourceTransactionOpen = true;
    validateSource(source);
    const rowsByTable = readSourceRows(source, options.tenantId);
    const client = await options.targetPool.connect();
    let destroyClient = false;
    try {
      await importIntoTarget(client, rowsByTable, options.tenantId, tenantDisplayName, options.dryRun === true);
    } catch (error) {
      destroyClient = true;
      throw error;
    } finally {
      client.release(destroyClient);
    }

    const rowCounts = Object.fromEntries(
      importTables.map((table) => [table.name, rowsByTable.get(table.name)!.length]),
    );
    return {
      dryRun: options.dryRun === true,
      tenantId: options.tenantId,
      rowCounts,
      totalRows: Object.values(rowCounts).reduce((total, count) => total + count, 0),
    };
  } finally {
    try {
      if (sourceTransactionOpen) {
        source.exec("rollback");
      }
    } finally {
      source.close();
    }
  }
}

function assertSourceFile(sourcePath: string): void {
  let sourceStat;
  try {
    sourceStat = statSync(sourcePath);
  } catch {
    throw new Error("SQLite source does not exist or is not readable.");
  }
  if (!sourceStat.isFile()) {
    throw new Error("SQLite source must be a regular file.");
  }
}

function validateSource(source: DatabaseSync): void {
  const integrityRows = source.prepare("pragma integrity_check").all() as SqliteRow[];
  if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== "ok") {
    throw new Error("SQLite source failed its integrity check.");
  }
  if (source.prepare("pragma foreign_key_check").all().length > 0) {
    throw new Error("SQLite source has foreign-key violations.");
  }
  const migration = source
    .prepare("select 1 as applied from runtime_migrations where name = ?")
    .get("0012_tenant_isolation.sql") as SqliteRow | undefined;
  if (!migration) {
    throw new Error("SQLite source is not at the current tenant-isolated schema.");
  }

  const foreignTenants = source.prepare("select id from tenants where id != ? limit 1").all(compatibilityTenantId);
  if (foreignTenants.length > 0) {
    throw new Error("SQLite source contains non-compatibility tenants and cannot be imported as one tenant.");
  }
  const compatibilityTenant = source.prepare("select 1 from tenants where id = ?").get(compatibilityTenantId);
  if (!compatibilityTenant) {
    throw new Error("SQLite source does not contain the compatibility tenant `local`.");
  }

  for (const table of importTables) {
    const actualColumns = new Set(
      (source.prepare(`pragma table_info(${table.name})`).all() as SqliteRow[]).map((row) => row.name),
    );
    const missingColumns = table.columns.filter((column) => !actualColumns.has(column));
    if (missingColumns.length > 0) {
      throw new Error(`SQLite source table ${table.name} is missing columns: ${missingColumns.join(", ")}.`);
    }
  }
}

function readSourceRows(source: DatabaseSync, targetTenantId: TenantId): Map<string, SqliteRow[]> {
  return new Map(
    importTables.map((table) => {
      const rows = source.prepare(`select ${table.columns.join(", ")} from ${table.name}`).all() as SqliteRow[];
      if (table.tenantScoped) {
        for (const row of rows) {
          if (row.tenant_id !== compatibilityTenantId) {
            throw new Error(`SQLite source table ${table.name} contains data outside the compatibility tenant.`);
          }
          row.tenant_id = targetTenantId;
        }
      }
      return [table.name, rows];
    }),
  );
}

async function importIntoTarget(
  client: PoolClient,
  rowsByTable: Map<string, SqliteRow[]>,
  tenantId: TenantId,
  tenantDisplayName: string,
  dryRun: boolean,
): Promise<void> {
  await client.query("begin isolation level serializable");
  try {
    await client.query("select pg_advisory_xact_lock($1, $2)", [importLockNamespace, importLockId]);
    await client.query(`
      lock table tenants, tenant_admin_credentials, connections, oauth_client_configs, oauth_states,
        runtime_tokens, runtime_policy, runs, idempotency_records in access exclusive mode
    `);
    await assertTargetEmpty(client);
    await client.query("insert into tenants (id, display_name, created_at) values ($1, $2, $3)", [
      tenantId,
      tenantDisplayName,
      new Date().toISOString(),
    ]);

    for (const table of importTables) {
      await insertRows(client, table, rowsByTable.get(table.name)!);
    }

    if (dryRun) {
      await client.query("rollback");
    } else {
      await client.query("commit");
    }
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function insertRows(client: PoolClient, table: ImportTable, rows: SqliteRow[]): Promise<void> {
  const batchSize = 250;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values = batch.flatMap((row) => table.columns.map((column) => row[column]));
    const tuples = batch.map((_, rowIndex) => {
      const parameterOffset = rowIndex * table.columns.length;
      return `(${table.columns.map((_, columnIndex) => `$${parameterOffset + columnIndex + 1}`).join(", ")})`;
    });
    await client.query(`insert into ${table.name} (${table.columns.join(", ")}) values ${tuples.join(", ")}`, values);
  }
}

async function assertTargetEmpty(client: PoolClient): Promise<void> {
  for (const table of importTables) {
    const result = await client.query<{ count: string }>(`select count(*)::text as count from ${table.name}`);
    if (result.rows[0]?.count !== "0") {
      throw new Error(`PostgreSQL destination is not empty: ${table.name} contains rows.`);
    }
  }

  const tenants = await client.query<{ id: string }>("select id from tenants order by id");
  if (tenants.rows.some((tenant) => tenant.id !== compatibilityTenantId) || tenants.rows.length !== 1) {
    throw new Error("PostgreSQL destination has tenant state and is not safe to import into.");
  }
}
