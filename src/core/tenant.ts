const tenantIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

declare const tenantIdBrand: unique symbol;

/** Immutable tenant identifier obtained from an authenticated server-side identity. */
export type TenantId = string & { readonly [tenantIdBrand]: true };

/** Owner used only for data migrated from the original single-tenant runtime. */
export const compatibilityTenantId = "local" as TenantId;

export interface OperatorPrincipal {
  kind: "operator";
  capability: "operator";
}

export interface TenantAdminPrincipal {
  kind: "tenant";
  capability: "tenant-admin";
  tenantId: TenantId;
  credentialId: string;
}

export interface TenantRuntimePrincipal {
  kind: "tenant";
  capability: "runtime";
  tenantId: TenantId;
  runtimeTokenId: string;
}

export type TenantPrincipal = TenantAdminPrincipal | TenantRuntimePrincipal;
export type AuthenticatedPrincipal = OperatorPrincipal | TenantPrincipal;

export const operatorPrincipal: OperatorPrincipal = { kind: "operator", capability: "operator" };

/** Validate a persisted or trusted-claim tenant identifier at the identity boundary. */
export function parseTenantId(value: string): TenantId {
  const normalized = value.trim();
  if (!tenantIdPattern.test(normalized)) {
    throw new Error("Tenant ID must contain 1-128 letters, digits, underscores, or hyphens.");
  }
  return normalized as TenantId;
}

export function requireTenantPrincipal(principal: AuthenticatedPrincipal | undefined): TenantPrincipal {
  if (principal?.kind !== "tenant") {
    throw new Error("A tenant principal is required.");
  }
  return principal;
}
