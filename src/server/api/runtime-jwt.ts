import type { TenantRuntimePrincipal } from "../../core/tenant.ts";

import { createRemoteJWKSet, jwtVerify } from "jose";
import { parseTenantId } from "../../core/tenant.ts";

export interface RuntimeJwtConfig {
  jwksUri?: string;
  issuer?: string;
  audience?: string;
  tenantClaim?: string;
}

export type LegacyRuntimeJwtVerifier = (token: string) => Promise<boolean>;
export type TenantRuntimeJwtVerifier = (token: string) => Promise<TenantRuntimePrincipal | undefined>;
export type RuntimeJwtVerifier = (token: string) => Promise<boolean | TenantRuntimePrincipal | undefined>;

/**
 * Creates a JWT access-token verifier when all runtime JWT settings are configured.
 */
export function createRuntimeJwtVerifier(
  config: RuntimeJwtConfig & { tenantClaim: string },
): TenantRuntimeJwtVerifier | undefined;
export function createRuntimeJwtVerifier(config: RuntimeJwtConfig): LegacyRuntimeJwtVerifier | undefined;
export function createRuntimeJwtVerifier(config: RuntimeJwtConfig): RuntimeJwtVerifier | undefined {
  const jwksUri = config.jwksUri?.trim();
  const issuer = config.issuer?.trim();
  const audience = config.audience?.trim();
  const tenantClaim = config.tenantClaim?.trim();
  if (!jwksUri && !issuer && !audience) {
    return undefined;
  }

  if (!jwksUri || !issuer || !audience) {
    const missing = [
      ["OOMOL_CONNECT_JWKS_URI", jwksUri],
      ["OOMOL_CONNECT_JWT_ISSUER", issuer],
      ["OOMOL_CONNECT_JWT_AUDIENCE", audience],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    throw new Error(`Runtime JWT authentication settings must be configured together; missing: ${missing.join(", ")}.`);
  }

  let url: URL;
  try {
    url = new URL(jwksUri);
  } catch {
    throw new Error("OOMOL_CONNECT_JWKS_URI must be a valid HTTPS URL or HTTP loopback URL.");
  }
  if (url.protocol !== "https:" && !isLoopbackHttpUrl(url)) {
    throw new Error("OOMOL_CONNECT_JWKS_URI must be a valid HTTPS URL or HTTP loopback URL.");
  }

  const jwks = createRemoteJWKSet(url);
  return async (token) => {
    try {
      const verified = await jwtVerify(token, jwks, {
        issuer,
        audience,
        requiredClaims: tenantClaim ? ["exp", tenantClaim] : ["exp"],
      });
      if (!tenantClaim) return true;
      const tenantValue = verified.payload[tenantClaim];
      if (typeof tenantValue !== "string") return undefined;
      return {
        kind: "tenant",
        capability: "runtime",
        tenantId: parseTenantId(tenantValue),
        runtimeTokenId: `jwt:${verified.payload.jti ?? verified.payload.sub ?? "anonymous"}`,
      };
    } catch {
      return tenantClaim ? undefined : false;
    }
  };
}

function isLoopbackHttpUrl(url: URL): boolean {
  if (url.protocol !== "http:") {
    return false;
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
}
