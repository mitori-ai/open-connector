import type { IConnectionStore, StoredConnection } from "../../connection-service.ts";
import type { TokenPolicy } from "../../core/action-policy.ts";
import type { TenantId } from "../../core/tenant.ts";
import type { ResolvedCredential } from "../../core/types.ts";
import type { IOAuthClientConfigStore, OAuthClientConfig } from "../../oauth/oauth-client-config-service.ts";
import type { IOAuthStateStore, OAuthAuthorizationState } from "../../oauth/oauth-flow-service.ts";
import type { D1DatabaseBinding } from "../cloudflare/cloudflare-bindings.ts";
import type { ISecretCodec } from "../secrets/secret-codec-core.ts";
import type {
  CompleteIdempotencyInput,
  IdempotencyClaimInput,
  IdempotencyClaimResult,
  IIdempotencyStore,
} from "./idempotency-store.ts";
import type { RuntimeDatabase } from "./runtime-database.ts";
import type { IRuntimePolicyStore, RuntimePolicyRecord } from "./runtime-policy-store.ts";
import type { IRunLogStore, RunLog, RunLogListInput, RunLogPage, RunLogWriteResult } from "./runtime-store.ts";
import type { IRuntimeTokenStore, RuntimeTokenRecord } from "./runtime-token-service.ts";
import type { ITenantCredentialStore, TenantAdminCredentialRecord, TenantRecord } from "./tenant-credential-service.ts";

import { compatibilityTenantId } from "../../core/tenant.ts";
import { parseRuntimeActionHttpResult } from "../api/runtime-api.ts";
import { PlainTextSecretCodec } from "../secrets/secret-codec-core.ts";
import { DEFAULT_RUN_LIMIT, decodeRunLogCursor, encodeRunLogCursor } from "./runtime-store.ts";

type RuntimeRow = Record<string, unknown>;
type SecretJsonTable = "oauth_client_configs";

export interface D1RuntimeDatabaseOptions {
  runLimit?: number;
  secretCodec?: ISecretCodec;
}

export class D1RuntimeDatabase implements RuntimeDatabase {
  readonly connectionStore: D1ConnectionStore;
  readonly oauthClientConfigStore: D1OAuthClientConfigStore;
  readonly oauthStateStore: D1OAuthStateStore;
  readonly runtimeTokenStore: D1RuntimeTokenStore;
  readonly runtimePolicyStore: D1RuntimePolicyStore;
  readonly runLogStore: D1RunLogStore;
  readonly idempotencyStore: D1IdempotencyStore;
  readonly tenantCredentialStore: D1TenantCredentialStore;

  constructor(database: D1DatabaseBinding, options: D1RuntimeDatabaseOptions = {}) {
    const secretCodec = options.secretCodec ?? new PlainTextSecretCodec();
    this.connectionStore = new D1ConnectionStore(database, secretCodec);
    this.oauthClientConfigStore = new D1OAuthClientConfigStore(database, secretCodec);
    this.oauthStateStore = new D1OAuthStateStore(database, secretCodec);
    this.runtimeTokenStore = new D1RuntimeTokenStore(database);
    this.runtimePolicyStore = new D1RuntimePolicyStore(database);
    this.runLogStore = new D1RunLogStore(database, options.runLimit ?? DEFAULT_RUN_LIMIT);
    this.idempotencyStore = new D1IdempotencyStore(database, secretCodec);
    this.tenantCredentialStore = new D1TenantCredentialStore(database);
  }
}

export class D1ConnectionStore implements IConnectionStore {
  private readonly database: D1DatabaseBinding;
  private readonly secretCodec: ISecretCodec;

  constructor(database: D1DatabaseBinding, secretCodec: ISecretCodec) {
    this.database = database;
    this.secretCodec = secretCodec;
  }

  async get(
    service: string,
    connectionName: string,
    tenantId: TenantId = compatibilityTenantId,
  ): Promise<StoredConnection | undefined> {
    const row = await this.database
      .prepare(
        "select id, revision, value from connections where tenant_id = ? and service = ? and connection_name = ?",
      )
      .bind(tenantId, service, connectionName)
      .first<RuntimeRow>();
    return row
      ? {
          id: readString(row, "id"),
          revision: readString(row, "revision"),
          service,
          connectionName,
          credential: parseJson<ResolvedCredential>(await this.secretCodec.decode(readString(row, "value"))),
        }
      : undefined;
  }

  async set(
    service: string,
    connectionName: string,
    credential: ResolvedCredential,
    tenantId: TenantId = compatibilityTenantId,
  ): Promise<StoredConnection> {
    const row = await this.database
      .prepare(
        `
        insert into connections (id, revision, tenant_id, service, connection_name, value, updated_at)
        values (?, ?, ?, ?, ?, ?, ?)
        on conflict(tenant_id, service, connection_name) do update set
          revision = excluded.revision,
          value = excluded.value,
          updated_at = excluded.updated_at
        returning id, revision
      `,
      )
      .bind(
        crypto.randomUUID(),
        crypto.randomUUID(),
        tenantId,
        service,
        connectionName,
        await this.secretCodec.encode(JSON.stringify(credential)),
        new Date().toISOString(),
      )
      .first<RuntimeRow>();
    return {
      id: readString(row!, "id"),
      revision: readString(row!, "revision"),
      service,
      connectionName,
      credential,
    };
  }

  async updateCredential(input: StoredConnection, tenantId: TenantId = compatibilityTenantId): Promise<boolean> {
    const row = await this.database
      .prepare(
        `
        update connections
        set revision = ?, value = ?, updated_at = ?
        where tenant_id = ? and service = ? and connection_name = ? and id = ? and revision = ?
        returning id
      `,
      )
      .bind(
        crypto.randomUUID(),
        await this.secretCodec.encode(JSON.stringify(input.credential)),
        new Date().toISOString(),
        tenantId,
        input.service,
        input.connectionName,
        input.id,
        input.revision,
      )
      .first<RuntimeRow>();
    return row !== null;
  }

  async delete(service: string, connectionName: string, tenantId: TenantId = compatibilityTenantId): Promise<void> {
    await this.database
      .prepare("delete from connections where tenant_id = ? and service = ? and connection_name = ?")
      .bind(tenantId, service, connectionName)
      .run();
  }

  async list(tenantId: TenantId = compatibilityTenantId): Promise<StoredConnection[]> {
    const { results } = await this.database
      .prepare(
        "select id, revision, service, connection_name, value from connections where tenant_id = ? order by service, connection_name",
      )
      .bind(tenantId)
      .all<RuntimeRow>();
    return await Promise.all(
      results.map(async (row) => ({
        id: readString(row, "id"),
        revision: readString(row, "revision"),
        service: readString(row, "service"),
        connectionName: readString(row, "connection_name"),
        credential: parseJson<ResolvedCredential>(await this.secretCodec.decode(readString(row, "value"))),
      })),
    );
  }

  async ownsConnection(connectionId: string, tenantId: TenantId = compatibilityTenantId): Promise<boolean> {
    return Boolean(
      await this.database
        .prepare("select 1 from connections where tenant_id = ? and id = ?")
        .bind(tenantId, connectionId)
        .first(),
    );
  }
}

export class D1OAuthClientConfigStore implements IOAuthClientConfigStore {
  private readonly database: D1DatabaseBinding;
  private readonly secretCodec: ISecretCodec;

  constructor(database: D1DatabaseBinding, secretCodec: ISecretCodec) {
    this.database = database;
    this.secretCodec = secretCodec;
  }

  async get(service: string): Promise<OAuthClientConfig | undefined> {
    return await getSecretJson<OAuthClientConfig>(this.database, this.secretCodec, "oauth_client_configs", service);
  }

  async set(config: OAuthClientConfig): Promise<void> {
    await this.database
      .prepare(
        `
        insert into oauth_client_configs (service, value, updated_at)
        values (?, ?, ?)
        on conflict(service) do update set value = excluded.value, updated_at = excluded.updated_at
      `,
      )
      .bind(config.service, await this.secretCodec.encode(JSON.stringify(config)), new Date().toISOString())
      .run();
  }

  async delete(service: string): Promise<void> {
    await this.database.prepare("delete from oauth_client_configs where service = ?").bind(service).run();
  }

  async list(): Promise<OAuthClientConfig[]> {
    const { results } = await this.database
      .prepare("select value from oauth_client_configs order by service")
      .all<RuntimeRow>();
    return await Promise.all(
      results.map(async (row) => parseJson<OAuthClientConfig>(await this.secretCodec.decode(readString(row, "value")))),
    );
  }
}

export class D1OAuthStateStore implements IOAuthStateStore {
  private readonly database: D1DatabaseBinding;
  private readonly secretCodec: ISecretCodec;

  constructor(database: D1DatabaseBinding, secretCodec: ISecretCodec) {
    this.database = database;
    this.secretCodec = secretCodec;
  }

  async set(state: OAuthAuthorizationState): Promise<void> {
    await this.database
      .prepare(
        `
        insert into oauth_states (state, tenant_id, value, created_at)
        values (?, ?, ?, ?)
        on conflict(state) do update set tenant_id = excluded.tenant_id, value = excluded.value, created_at = excluded.created_at
      `,
      )
      .bind(
        state.state,
        state.tenantId ?? compatibilityTenantId,
        await this.secretCodec.encode(JSON.stringify(state)),
        state.createdAt,
      )
      .run();
  }

  async take(state: string): Promise<OAuthAuthorizationState | undefined> {
    const row = await this.database
      .prepare("delete from oauth_states where state = ? returning value")
      .bind(state)
      .first<RuntimeRow>();
    return row
      ? parseJson<OAuthAuthorizationState>(await this.secretCodec.decode(readString(row, "value")))
      : undefined;
  }
}

export class D1RuntimeTokenStore implements IRuntimeTokenStore {
  private readonly database: D1DatabaseBinding;

  constructor(database: D1DatabaseBinding) {
    this.database = database;
  }

  async hasActiveToken(): Promise<boolean> {
    return Boolean(
      await this.database.prepare("select 1 from runtime_tokens where revoked_at is null limit 1").first(),
    );
  }

  async add(record: RuntimeTokenRecord): Promise<void> {
    await this.database
      .prepare(
        `
        insert into runtime_tokens (
          id, tenant_id, name, token_hash, allowed_actions, blocked_actions, allowed_proxies, allowed_connections, created_at, last_used_at
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .bind(
        record.id,
        record.tenantId ?? compatibilityTenantId,
        record.name,
        record.tokenHash,
        JSON.stringify(record.allowedActions),
        JSON.stringify(record.blockedActions),
        JSON.stringify(record.allowedProxies),
        JSON.stringify(record.allowedConnections ?? []),
        record.createdAt,
        record.lastUsedAt ?? null,
      )
      .run();
  }

  async list(tenantId: TenantId = compatibilityTenantId): Promise<RuntimeTokenRecord[]> {
    const { results } = await this.database
      .prepare(
        `
        select id, tenant_id, name, token_hash, allowed_actions, blocked_actions, allowed_proxies, allowed_connections, created_at, last_used_at
        from runtime_tokens
        where tenant_id = ? and revoked_at is null
        order by created_at desc, id desc
      `,
      )
      .bind(tenantId)
      .all<RuntimeRow>();
    return results.map(readRuntimeTokenRow);
  }

  async findByHash(tokenHash: string): Promise<RuntimeTokenRecord | undefined> {
    const row = await this.database
      .prepare(
        `
        select id, tenant_id, name, token_hash, allowed_actions, blocked_actions, allowed_proxies, allowed_connections, created_at, last_used_at
        from runtime_tokens
        where token_hash = ? and revoked_at is null
      `,
      )
      .bind(tokenHash)
      .first<RuntimeRow>();
    return row ? readRuntimeTokenRow(row) : undefined;
  }

  async updatePolicy(
    id: string,
    policy: TokenPolicy,
    tenantId: TenantId = compatibilityTenantId,
  ): Promise<RuntimeTokenRecord | undefined> {
    const row = await this.database
      .prepare(
        `
        update runtime_tokens
        set allowed_actions = ?, blocked_actions = ?, allowed_proxies = ?, allowed_connections = ?
        where tenant_id = ? and id = ? and revoked_at is null
        returning id, tenant_id, name, token_hash, allowed_actions, blocked_actions, allowed_proxies, allowed_connections, created_at, last_used_at
      `,
      )
      .bind(
        JSON.stringify(policy.allowedActions),
        JSON.stringify(policy.blockedActions),
        JSON.stringify(policy.allowedProxies),
        JSON.stringify(policy.allowedConnections ?? []),
        tenantId,
        id,
      )
      .first<RuntimeRow>();
    return row ? readRuntimeTokenRow(row) : undefined;
  }

  async revoke(id: string, tenantId: TenantId = compatibilityTenantId): Promise<boolean> {
    const result = await this.database
      .prepare("delete from runtime_tokens where tenant_id = ? and id = ?")
      .bind(tenantId, id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async markUsed(id: string, usedAt: string, tenantId: TenantId = compatibilityTenantId): Promise<void> {
    await this.database
      .prepare("update runtime_tokens set last_used_at = ? where tenant_id = ? and id = ? and revoked_at is null")
      .bind(usedAt, tenantId, id)
      .run();
  }
}

function readRuntimeTokenRow(row: RuntimeRow): RuntimeTokenRecord {
  return {
    id: readString(row, "id"),
    tenantId: readString(row, "tenant_id") as TenantId,
    name: readString(row, "name"),
    tokenHash: readString(row, "token_hash"),
    allowedActions: parseJson(readString(row, "allowed_actions")),
    blockedActions: parseJson(readString(row, "blocked_actions")),
    allowedProxies: parseJson(readString(row, "allowed_proxies")),
    allowedConnections: parseJson(readOptionalString(row, "allowed_connections") ?? "[]"),
    createdAt: readString(row, "created_at"),
    lastUsedAt: readOptionalString(row, "last_used_at"),
  };
}

export class D1TenantCredentialStore implements ITenantCredentialStore {
  private readonly database: D1DatabaseBinding;

  constructor(database: D1DatabaseBinding) {
    this.database = database;
  }

  async hasActiveCredential(): Promise<boolean> {
    return Boolean(
      await this.database.prepare("select 1 from tenant_admin_credentials where revoked_at is null limit 1").first(),
    );
  }

  async createTenant(record: TenantRecord): Promise<void> {
    await this.database
      .prepare("insert into tenants (id, display_name, created_at, disabled_at) values (?, ?, ?, ?)")
      .bind(record.id, record.displayName, record.createdAt, record.disabledAt ?? null)
      .run();
  }

  async getTenant(tenantId: TenantId): Promise<TenantRecord | undefined> {
    const row = await this.database
      .prepare("select id, display_name, created_at, disabled_at from tenants where id = ?")
      .bind(tenantId)
      .first<RuntimeRow>();
    return row ? readTenantRow(row) : undefined;
  }

  async listTenants(): Promise<TenantRecord[]> {
    const rows = await this.database
      .prepare("select id, display_name, created_at, disabled_at from tenants order by created_at, id")
      .all<RuntimeRow>();
    return rows.results.map(readTenantRow);
  }

  async disableTenant(tenantId: TenantId, disabledAt: string): Promise<boolean> {
    const result = await this.database
      .prepare("update tenants set disabled_at = ? where id = ?")
      .bind(disabledAt, tenantId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async addCredential(record: TenantAdminCredentialRecord): Promise<void> {
    await this.database
      .prepare(
        "insert into tenant_admin_credentials (id, tenant_id, name, token_hash, created_at, last_used_at, revoked_at) values (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        record.id,
        record.tenantId,
        record.name,
        record.tokenHash,
        record.createdAt,
        record.lastUsedAt ?? null,
        record.revokedAt ?? null,
      )
      .run();
  }

  async findCredentialByHash(tokenHash: string): Promise<TenantAdminCredentialRecord | undefined> {
    const row = await this.database
      .prepare(
        "select id, tenant_id, name, token_hash, created_at, last_used_at, revoked_at from tenant_admin_credentials where token_hash = ? and revoked_at is null",
      )
      .bind(tokenHash)
      .first<RuntimeRow>();
    return row ? readTenantCredentialRow(row) : undefined;
  }

  async listCredentials(tenantId: TenantId): Promise<TenantAdminCredentialRecord[]> {
    const rows = await this.database
      .prepare(
        "select id, tenant_id, name, token_hash, created_at, last_used_at, revoked_at from tenant_admin_credentials where tenant_id = ? order by created_at desc",
      )
      .bind(tenantId)
      .all<RuntimeRow>();
    return rows.results.map(readTenantCredentialRow);
  }

  async revokeCredential(tenantId: TenantId, credentialId: string, revokedAt: string): Promise<boolean> {
    const result = await this.database
      .prepare(
        "update tenant_admin_credentials set revoked_at = ? where tenant_id = ? and id = ? and revoked_at is null",
      )
      .bind(revokedAt, tenantId, credentialId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async markCredentialUsed(credentialId: string, usedAt: string): Promise<void> {
    await this.database
      .prepare("update tenant_admin_credentials set last_used_at = ? where id = ? and revoked_at is null")
      .bind(usedAt, credentialId)
      .run();
  }
}

function readTenantRow(row: RuntimeRow): TenantRecord {
  return {
    id: readString(row, "id") as TenantId,
    displayName: readString(row, "display_name"),
    createdAt: readString(row, "created_at"),
    disabledAt: readOptionalString(row, "disabled_at"),
  };
}

function readTenantCredentialRow(row: RuntimeRow): TenantAdminCredentialRecord {
  return {
    id: readString(row, "id"),
    tenantId: readString(row, "tenant_id") as TenantId,
    name: readString(row, "name"),
    tokenHash: readString(row, "token_hash"),
    createdAt: readString(row, "created_at"),
    lastUsedAt: readOptionalString(row, "last_used_at"),
    revokedAt: readOptionalString(row, "revoked_at"),
  };
}

export class D1RuntimePolicyStore implements IRuntimePolicyStore {
  private readonly database: D1DatabaseBinding;

  constructor(database: D1DatabaseBinding) {
    this.database = database;
  }

  async get(): Promise<RuntimePolicyRecord | undefined> {
    const row = await this.database
      .prepare("select value, updated_at from runtime_policy where id = 1")
      .first<RuntimeRow>();
    return row
      ? {
          rules: parseJson(readString(row, "value")),
          updatedAt: readString(row, "updated_at"),
        }
      : undefined;
  }

  async set(record: RuntimePolicyRecord): Promise<void> {
    await this.database
      .prepare(
        `
        insert into runtime_policy (id, value, updated_at)
        values (1, ?, ?)
        on conflict(id) do update set value = excluded.value, updated_at = excluded.updated_at
      `,
      )
      .bind(JSON.stringify(record.rules), record.updatedAt)
      .run();
  }
}

export class D1IdempotencyStore implements IIdempotencyStore {
  private readonly database: D1DatabaseBinding;
  private readonly secretCodec: ISecretCodec;

  constructor(database: D1DatabaseBinding, secretCodec: ISecretCodec) {
    this.database = database;
    this.secretCodec = secretCodec;
  }

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    await this.database.prepare("delete from idempotency_records where expires_at <= ?").bind(input.now).run();

    const inserted = await this.database
      .prepare(
        `
        insert into idempotency_records (
          tenant_id, key_hash, claim_id, request_hash, state, response_value, created_at, expires_at
        )
        values (?, ?, ?, ?, 'in_progress', null, ?, ?)
        on conflict(tenant_id, key_hash) do nothing
      `,
      )
      .bind(
        input.tenantId ?? compatibilityTenantId,
        input.keyHash,
        input.claimId,
        input.requestHash,
        input.now,
        input.expiresAt,
      )
      .run();
    if ((inserted.meta.changes ?? 0) > 0) {
      return { kind: "acquired" };
    }

    const row = await this.database
      .prepare(
        "select request_hash, state, response_value from idempotency_records where tenant_id = ? and key_hash = ?",
      )
      .bind(input.tenantId ?? compatibilityTenantId, input.keyHash)
      .first<RuntimeRow>();
    if (!row) {
      throw new Error("Idempotency record disappeared while claiming it.");
    }
    if (readString(row, "request_hash") !== input.requestHash) {
      return { kind: "conflict" };
    }
    if (readString(row, "state") === "in_progress") {
      return { kind: "in_progress" };
    }

    const response = parseRuntimeActionHttpResult(
      parseJson(await this.secretCodec.decode(readString(row, "response_value"))),
    );
    return { kind: "completed", response };
  }

  async complete(input: CompleteIdempotencyInput): Promise<boolean> {
    const result = await this.database
      .prepare(
        `
        update idempotency_records
        set state = 'completed', response_value = ?, expires_at = ?
        where tenant_id = ?
          and key_hash = ?
          and claim_id = ?
          and request_hash = ?
          and state = 'in_progress'
      `,
      )
      .bind(
        await this.secretCodec.encode(JSON.stringify(input.response)),
        input.expiresAt,
        input.tenantId ?? compatibilityTenantId,
        input.keyHash,
        input.claimId,
        input.requestHash,
      )
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
}

export class D1RunLogStore implements IRunLogStore {
  private readonly database: D1DatabaseBinding;
  private readonly limit: number;

  constructor(database: D1DatabaseBinding, limit: number) {
    this.database = database;
    this.limit = limit;
  }

  async add(run: RunLog, tenantId: TenantId = compatibilityTenantId): Promise<RunLogWriteResult> {
    await this.database
      .prepare(
        `
        insert into runs (id, tenant_id, service, action_id, caller, started_at, completed_at, ok, value)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          service = excluded.service,
          tenant_id = excluded.tenant_id,
          action_id = excluded.action_id,
          caller = excluded.caller,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          ok = excluded.ok,
          value = excluded.value
      `,
      )
      .bind(
        run.id,
        tenantId,
        run.service,
        run.actionId,
        run.caller,
        run.startedAt,
        run.completedAt,
        run.ok ? 1 : 0,
        JSON.stringify(run),
      )
      .run();

    try {
      await this.database
        .prepare(
          `
          delete from runs
          where id in (
            select id from runs where tenant_id = ?
            order by started_at desc, id desc
            limit -1 offset ?
          )
        `,
        )
        .bind(tenantId, this.limit)
        .run();
      return { retentionApplied: true };
    } catch {
      return { retentionApplied: false };
    }
  }

  async get(id: string, tenantId: TenantId = compatibilityTenantId): Promise<RunLog | undefined> {
    const row = await this.database
      .prepare("select service, value from runs where tenant_id = ? and id = ?")
      .bind(tenantId, id)
      .first<RuntimeRow>();
    return row ? readRunLogRow(row) : undefined;
  }

  async list(input: RunLogListInput = {}, tenantId: TenantId = compatibilityTenantId): Promise<RunLogPage> {
    const limit = Math.max(1, Math.min(input.limit ?? this.limit, this.limit));
    const cursor = decodeRunLogCursor(input.cursor);
    const conditions: string[] = ["tenant_id = ?"];
    const values: Array<string | number> = [tenantId];
    if (cursor) {
      conditions.push("(started_at < ? or (started_at = ? and id < ?))");
      values.push(cursor.startedAt, cursor.startedAt, cursor.id);
    }
    if (input.service) {
      conditions.push("service = ?");
      values.push(input.service);
    }
    if (input.actionId) {
      conditions.push("action_id = ?");
      values.push(input.actionId);
    }
    if (input.caller) {
      conditions.push("caller = ?");
      values.push(input.caller);
    }
    if (input.ok !== undefined) {
      conditions.push("ok = ?");
      values.push(input.ok ? 1 : 0);
    }
    const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
    const { results } = await this.database
      .prepare(`select service, value from runs ${where} order by started_at desc, id desc limit ?`)
      .bind(...values, limit + 1)
      .all<RuntimeRow>();
    const runs = results.map(readRunLogRow);
    const items = runs.slice(0, limit);

    return {
      items,
      nextCursor: runs.length > limit && items.length > 0 ? encodeRunLogCursor(items[items.length - 1]) : undefined,
    };
  }
}

async function getSecretJson<T>(
  database: D1DatabaseBinding,
  secretCodec: ISecretCodec,
  table: SecretJsonTable,
  service: string,
): Promise<T | undefined> {
  const row = await database.prepare(`select value from ${table} where service = ?`).bind(service).first<RuntimeRow>();
  return row ? parseJson<T>(await secretCodec.decode(readString(row, "value"))) : undefined;
}

function readString(row: RuntimeRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected D1 column ${key} to be a string.`);
  }

  return value;
}

function readRunLogRow(row: RuntimeRow): RunLog {
  const run = parseJson<RunLog>(readString(row, "value"));
  return { ...run, service: readString(row, "service") };
}

function readOptionalString(row: RuntimeRow, key: string): string | undefined {
  const value = row[key];
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected D1 column ${key} to be a string.`);
  }

  return value;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
