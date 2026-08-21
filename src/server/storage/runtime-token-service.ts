import type { IConnectionStore } from "../../connection-service.ts";
import type { TokenPolicy } from "../../core/action-policy.ts";
import type { TenantId } from "../../core/tenant.ts";
import type { RuntimeLogger } from "../../core/types.ts";

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { compatibilityTenantId } from "../../core/tenant.ts";

export interface RuntimeTokenRecord {
  id: string;
  tenantId?: TenantId;
  name: string;
  tokenHash: string;
  allowedActions: string[];
  blockedActions: string[];
  allowedProxies: string[];
  allowedConnections: string[];
  createdAt: string;
  lastUsedAt?: string;
}

export interface RuntimeTokenSummary {
  id: string;
  tenantId?: TenantId;
  name: string;
  allowedActions: string[];
  blockedActions: string[];
  allowedProxies: string[];
  allowedConnections: string[];
  createdAt: string;
  lastUsedAt?: string;
}

export interface RuntimeTokenCreation {
  token: string;
  record: RuntimeTokenRecord;
}

export interface IRuntimeTokenStore {
  hasActiveToken?(): Promise<boolean>;
  add(record: RuntimeTokenRecord): Promise<void>;
  list(tenantId?: TenantId): Promise<RuntimeTokenRecord[]>;
  findByHash(tokenHash: string): Promise<RuntimeTokenRecord | undefined>;
  updatePolicy(id: string, policy: TokenPolicy, tenantId?: TenantId): Promise<RuntimeTokenRecord | undefined>;
  revoke(id: string, tenantId?: TenantId): Promise<boolean>;
  markUsed(id: string, usedAt: string, tenantId?: TenantId): Promise<void>;
}

const tokenPrefix = "oct_";

export interface RuntimeGrant extends TokenPolicy {
  tokenId: string;
  tenantId?: TenantId;
}

export class RuntimeTokenService {
  private readonly store: IRuntimeTokenStore;
  private readonly connections?: IConnectionStore;
  private readonly logger?: RuntimeLogger;

  constructor(store: IRuntimeTokenStore, logger?: RuntimeLogger, connections?: IConnectionStore) {
    this.store = store;
    this.connections = connections;
    this.logger = logger;
  }

  async hasTokens(): Promise<boolean> {
    return this.store.hasActiveToken ? this.store.hasActiveToken() : (await this.store.list()).length > 0;
  }

  async createToken(
    name: string,
    policy: TokenPolicy = {
      allowedActions: [],
      blockedActions: [],
      allowedProxies: [],
      allowedConnections: [],
    },
    tenantId: TenantId = compatibilityTenantId,
  ): Promise<RuntimeTokenCreation> {
    const token = `${tokenPrefix}${randomBytes(32).toString("base64url")}`;
    const now = new Date().toISOString();
    const record: RuntimeTokenRecord = {
      id: randomUUID(),
      tenantId,
      name: name.trim(),
      tokenHash: hashRuntimeToken(token),
      allowedActions: policy.allowedActions,
      blockedActions: policy.blockedActions,
      allowedProxies: policy.allowedProxies,
      allowedConnections: policy.allowedConnections ?? [],
      createdAt: now,
    };
    await this.assertAllowedConnectionsOwned(tenantId, record.allowedConnections);
    await this.store.add(record);
    return { token, record };
  }

  async listTokens(tenantId: TenantId = compatibilityTenantId): Promise<RuntimeTokenSummary[]> {
    return (await this.store.list(tenantId)).map(summarizeRuntimeToken);
  }

  async revokeToken(id: string, tenantId: TenantId = compatibilityTenantId): Promise<boolean> {
    return this.store.revoke(id, tenantId);
  }

  async updateTokenPolicy(
    id: string,
    policy: TokenPolicy,
    tenantId: TenantId = compatibilityTenantId,
  ): Promise<RuntimeTokenSummary | undefined> {
    await this.assertAllowedConnectionsOwned(tenantId, policy.allowedConnections ?? []);
    const record = await this.store.updatePolicy(id, policy, tenantId);
    return record ? summarizeRuntimeToken(record) : undefined;
  }

  async resolveToken(token: string): Promise<RuntimeGrant | undefined> {
    if (!token.startsWith(tokenPrefix)) {
      return undefined;
    }
    const tokenHash = hashRuntimeToken(token);
    const matched = await this.store.findByHash(tokenHash);
    if (!matched || !equalHashes(matched.tokenHash, tokenHash)) {
      return undefined;
    }

    await this.recordLastUsed(matched.id, matched.tenantId);
    return {
      tokenId: matched.id,
      tenantId: matched.tenantId,
      allowedActions: matched.allowedActions,
      blockedActions: matched.blockedActions,
      allowedProxies: matched.allowedProxies,
      allowedConnections: matched.allowedConnections ?? [],
    };
  }

  async verifyToken(token: string): Promise<boolean> {
    return Boolean(await this.resolveToken(token));
  }

  /**
   * `last_used_at` is best-effort audit metadata, so a failed write is logged
   * instead of turning an authenticated caller into a failed request.
   */
  private async recordLastUsed(tokenId: string, tenantId?: TenantId): Promise<void> {
    try {
      if (tenantId) {
        await this.store.markUsed(tokenId, new Date().toISOString(), tenantId);
      } else {
        await this.store.markUsed(tokenId, new Date().toISOString());
      }
    } catch (error) {
      this.logger?.warn({ tokenId, err: error }, "runtime token last use update failed");
    }
  }

  private async assertAllowedConnectionsOwned(tenantId: TenantId, connectionIds: string[]): Promise<void> {
    if (!this.connections) return;
    for (const connectionId of connectionIds) {
      if (!this.connections.ownsConnection || !(await this.connections.ownsConnection(connectionId, tenantId))) {
        throw new RuntimeTokenPolicyError(`Connection is not owned by this tenant: ${connectionId}.`);
      }
    }
  }
}

export class RuntimeTokenPolicyError extends Error {}

export function hashRuntimeToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function summarizeRuntimeToken(record: RuntimeTokenRecord): RuntimeTokenSummary {
  return {
    id: record.id,
    tenantId: record.tenantId,
    name: record.name,
    allowedActions: record.allowedActions,
    blockedActions: record.blockedActions,
    allowedProxies: record.allowedProxies,
    allowedConnections: record.allowedConnections,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
  };
}

function equalHashes(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
