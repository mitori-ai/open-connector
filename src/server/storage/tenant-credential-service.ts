import type { TenantId } from "../../core/tenant.ts";
import type { RuntimeLogger } from "../../core/types.ts";

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export interface TenantRecord {
  id: TenantId;
  displayName: string;
  createdAt: string;
  disabledAt?: string;
}

export interface TenantAdminCredentialRecord {
  id: string;
  tenantId: TenantId;
  name: string;
  tokenHash: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface TenantAdminCredentialCreation {
  credential: string;
  record: TenantAdminCredentialRecord;
}

export interface ITenantCredentialStore {
  hasActiveCredential(): Promise<boolean>;
  createTenant(record: TenantRecord): Promise<void>;
  getTenant(tenantId: TenantId): Promise<TenantRecord | undefined>;
  listTenants(): Promise<TenantRecord[]>;
  disableTenant(tenantId: TenantId, disabledAt: string): Promise<boolean>;
  addCredential(record: TenantAdminCredentialRecord): Promise<void>;
  findCredentialByHash(tokenHash: string): Promise<TenantAdminCredentialRecord | undefined>;
  listCredentials(tenantId: TenantId): Promise<TenantAdminCredentialRecord[]>;
  revokeCredential(tenantId: TenantId, credentialId: string, revokedAt: string): Promise<boolean>;
  markCredentialUsed(credentialId: string, usedAt: string): Promise<void>;
}

const tenantAdminPrefix = "octa_";

/** Operator-owned provisioning and credential-derived tenant authentication. */
export class TenantCredentialService {
  private readonly store: ITenantCredentialStore;
  private readonly logger?: RuntimeLogger;

  constructor(store: ITenantCredentialStore, logger?: RuntimeLogger) {
    this.store = store;
    this.logger = logger;
  }

  hasAdminCredentials(): Promise<boolean> {
    return this.store.hasActiveCredential();
  }

  async createTenant(record: TenantRecord): Promise<void> {
    await this.store.createTenant(record);
  }

  listTenants(): Promise<TenantRecord[]> {
    return this.store.listTenants();
  }

  async issueAdminCredential(tenantId: TenantId, name: string): Promise<TenantAdminCredentialCreation> {
    const tenant = await this.store.getTenant(tenantId);
    if (!tenant || tenant.disabledAt) {
      throw new Error("Tenant was not found or is disabled.");
    }
    const credential = `${tenantAdminPrefix}${randomBytes(32).toString("base64url")}`;
    const record: TenantAdminCredentialRecord = {
      id: randomUUID(),
      tenantId,
      name: name.trim(),
      tokenHash: hashTenantAdminCredential(credential),
      createdAt: new Date().toISOString(),
    };
    await this.store.addCredential(record);
    return { credential, record };
  }

  listAdminCredentials(tenantId: TenantId): Promise<TenantAdminCredentialRecord[]> {
    return this.store.listCredentials(tenantId);
  }

  revokeAdminCredential(tenantId: TenantId, credentialId: string): Promise<boolean> {
    return this.store.revokeCredential(tenantId, credentialId, new Date().toISOString());
  }

  async resolveAdminCredential(credential: string): Promise<TenantAdminCredentialRecord | undefined> {
    if (!credential.startsWith(tenantAdminPrefix)) return undefined;
    const tokenHash = hashTenantAdminCredential(credential);
    const record = await this.store.findCredentialByHash(tokenHash);
    if (!record || record.revokedAt || !equalHashes(record.tokenHash, tokenHash)) return undefined;
    const tenant = await this.store.getTenant(record.tenantId);
    if (!tenant || tenant.disabledAt) return undefined;
    try {
      await this.store.markCredentialUsed(record.id, new Date().toISOString());
    } catch (error) {
      this.logger?.warn({ credentialId: record.id, err: error }, "tenant admin credential last use update failed");
    }
    return record;
  }
}

export function hashTenantAdminCredential(credential: string): string {
  return createHash("sha256").update(credential).digest("base64url");
}

function equalHashes(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
