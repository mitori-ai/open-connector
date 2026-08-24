import type { AuthenticatedPrincipal, TenantId } from "../../core/tenant.ts";
import type { RuntimeGrant } from "../storage/runtime-token-service.ts";
import type { TenantCredentialService } from "../storage/tenant-credential-service.ts";
import type { RuntimeJwtVerifier } from "./runtime-jwt.ts";
import type { Context, MiddlewareHandler } from "hono";

import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { compatibilityTenantId, operatorPrincipal, parseTenantId } from "../../core/tenant.ts";
import { isConsoleShellRequest } from "./console-paths.ts";
import { jsonError } from "./http-utils.ts";

const bearerScheme = "bearer";
const authCookieName = "oomol_connect_admin_session";
const authCookieVersion = "v1";
const authCookieMaxAgeSeconds = 2_592_000;
const authCookieMaxAgeMs = authCookieMaxAgeSeconds * 1000;
const tenantSessionCookieName = "oomol_connect_operator_tenant_session";
const tenantSessionCookieVersion = "v1";
const tenantSessionMaxAgeSeconds = 3_600;
const tenantSessionMaxAgeMs = tenantSessionMaxAgeSeconds * 1000;
const tenantSessionSecrets = new WeakMap<LocalAuthOptions, string>();

/**
 * Optional API authentication for HTTP, web console, and MCP callers.
 */
export interface LocalAuthOptions {
  adminToken?: string;
  runtimeToken?: string;
  sharedRuntime?: boolean;
  hasRuntimeTokens?(): Promise<boolean>;
  hasTenantAdminCredentials?(): Promise<boolean>;
  resolveRuntimeToken?(token: string): Promise<RuntimeGrant | undefined>;
  tenantCredentials?: TenantCredentialService;
  verifyRuntimeJwt?: RuntimeJwtVerifier;
}

export interface LocalAuthSession {
  adminAuthConfigured: boolean;
  authenticated: boolean;
  sharedRuntime: boolean;
  tenantId?: TenantId;
}

type AuthScope = "operator" | "tenant" | "tenant-admin" | "runtime";

const runtimeGrants = new WeakMap<Request, RuntimeGrant>();
const principals = new WeakMap<Request, AuthenticatedPrincipal>();

export function readRuntimeGrant(context: Context): RuntimeGrant | undefined {
  return runtimeGrants.get(context.req.raw);
}

export function readAuthenticatedPrincipal(context: Context): AuthenticatedPrincipal | undefined {
  return principals.get(context.req.raw);
}

export function createLocalAuthMiddleware(options: LocalAuthOptions): MiddlewareHandler {
  const adminToken = normalizeToken(options.adminToken);
  const runtimeToken = normalizeToken(options.runtimeToken);
  if (
    !adminToken &&
    !runtimeToken &&
    !options.hasRuntimeTokens &&
    !options.hasTenantAdminCredentials &&
    !options.resolveRuntimeToken &&
    !options.tenantCredentials &&
    !options.verifyRuntimeJwt &&
    !options.sharedRuntime
  ) {
    return async (_context, next) => {
      await next();
    };
  }

  return async (context, next) => {
    const scope = readAuthScope(context.req.path);
    if (isPublicPath(context.req.path, context.req.method)) {
      await next();
      return;
    }

    const principal = await resolvePrincipal(context, options, scope);
    if (principal) {
      principals.set(context.req.raw, principal);
      if (scope === "operator") {
        await installAdminCookieForBearer(context, options);
      }
      await next();
      return;
    }

    // Admin elevation for action runs is only available when an admin token is
    // configured. Without that, a missing admin token must not open POST
    // /v1/actions/* while runtime tokens/JWT are otherwise enforcing auth.
    if (
      canUseAdminAuth(context.req.path, context.req.method) &&
      normalizeToken(options.adminToken) &&
      (await resolvePrincipal(context, options, "operator"))
    ) {
      await installAdminCookieForBearer(context, options);
      await next();
      return;
    }

    return jsonError(context, 401, "unauthorized", "A valid local bearer token is required.");
  };
}

async function installLocalAuthCookie(context: Context, options: LocalAuthOptions): Promise<void> {
  const token = normalizeToken(options.adminToken);
  if (!token) {
    return;
  }

  setCookie(context, authCookieName, await createAuthCookieValue(token), {
    httpOnly: true,
    maxAge: authCookieMaxAgeSeconds,
    sameSite: "Strict",
    secure: context.req.url.startsWith("https://"),
    path: "/",
  });
}

function isPublicPath(path: string, method: string): boolean {
  return (
    path === "/health" ||
    path === "/oauth/callback" ||
    path.startsWith("/oauth/callback/") ||
    (method === "GET" && path === "/api/auth/session") ||
    (method === "POST" && path === "/api/auth/logout") ||
    isConsoleShellRequest(path, method)
  );
}

export async function readLocalAuthSession(context: Context, options: LocalAuthOptions): Promise<LocalAuthSession> {
  const adminToken = normalizeToken(options.adminToken);
  if (!adminToken) {
    return {
      adminAuthConfigured: false,
      authenticated: true,
      sharedRuntime: Boolean(options.sharedRuntime),
      tenantId: await readOperatorTenantSession(context, options),
    };
  }

  const authenticated = await hasRequestToken(context, adminToken);
  if (authenticated) {
    await installAdminCookieForBearer(context, options);
  }

  return {
    adminAuthConfigured: true,
    authenticated,
    sharedRuntime: Boolean(options.sharedRuntime),
    tenantId: authenticated ? await readOperatorTenantSession(context, options) : undefined,
  };
}

export function clearLocalAuthCookie(context: Context): void {
  deleteCookie(context, authCookieName, {
    httpOnly: true,
    sameSite: "Strict",
    secure: context.req.url.startsWith("https://"),
    path: "/",
  });
  clearOperatorTenantSession(context);
}

/**
 * Scope an authenticated operator's web console to one active tenant.
 *
 * The short-lived cookie contains no credential and is accepted only together
 * with the operator's existing authenticated session.
 */
export async function installOperatorTenantSession(
  context: Context,
  options: LocalAuthOptions,
  tenantId: TenantId,
): Promise<void> {
  if (
    !options.sharedRuntime ||
    !(await isOperatorAuthenticated(context, options)) ||
    !(await isTenantActive(options, tenantId))
  ) {
    throw new Error("An authenticated operator and active shared-runtime tenant are required.");
  }

  const signingSecret = tenantSessionSigningSecret(options);
  const payload = `${tenantSessionCookieVersion}.${Date.now()}.${tenantId}.${base64Url(
    crypto.getRandomValues(new Uint8Array(16)),
  )}`;
  setCookie(
    context,
    tenantSessionCookieName,
    `${payload}.${await signAuthCookiePayload(`tenant.${payload}`, signingSecret)}`,
    {
      httpOnly: true,
      maxAge: tenantSessionMaxAgeSeconds,
      sameSite: "Strict",
      secure: context.req.url.startsWith("https://"),
      path: "/",
    },
  );
}

export function clearOperatorTenantSession(context: Context): void {
  deleteCookie(context, tenantSessionCookieName, {
    httpOnly: true,
    sameSite: "Strict",
    secure: context.req.url.startsWith("https://"),
    path: "/",
  });
}

async function installAdminCookieForBearer(context: Context, options: LocalAuthOptions): Promise<void> {
  const token = normalizeToken(options.adminToken);
  if (token && matchesConfiguredToken(context, token)) {
    await installLocalAuthCookie(context, options);
  }
}

async function resolvePrincipal(
  context: Context,
  options: LocalAuthOptions,
  scope: AuthScope,
): Promise<AuthenticatedPrincipal | undefined> {
  if (scope === "tenant") {
    const token = readBearerToken(context);
    const tenantAdmin = token ? await options.tenantCredentials?.resolveAdminCredential(token) : undefined;
    if (tenantAdmin) {
      return {
        kind: "tenant",
        capability: "tenant-admin",
        tenantId: tenantAdmin.tenantId,
        credentialId: tenantAdmin.id,
      };
    }
    const runtime = await resolveRuntimePrincipal(context, options);
    if (runtime) return runtime;
    const adminToken = normalizeToken(options.adminToken);
    if (adminToken && (await hasRequestToken(context, adminToken))) return operatorPrincipal;
    const hasRuntimeTokens = options.hasRuntimeTokens
      ? await options.hasRuntimeTokens()
      : options.resolveRuntimeToken !== undefined;
    const hasTenantAdminCredentials = options.hasTenantAdminCredentials
      ? await options.hasTenantAdminCredentials()
      : options.tenantCredentials !== undefined;
    if (
      !adminToken &&
      !normalizeToken(options.runtimeToken) &&
      !hasRuntimeTokens &&
      !hasTenantAdminCredentials &&
      !options.verifyRuntimeJwt &&
      !options.sharedRuntime
    ) {
      return {
        kind: "tenant",
        capability: "runtime",
        tenantId: compatibilityTenantId,
        runtimeTokenId: "local-open",
      };
    }
    return undefined;
  }
  if (scope === "tenant-admin") {
    const token = readBearerToken(context);
    const record = token ? await options.tenantCredentials?.resolveAdminCredential(token) : undefined;
    if (record) {
      return { kind: "tenant", capability: "tenant-admin", tenantId: record.tenantId, credentialId: record.id };
    }
    const tenantId = await readOperatorTenantSession(context, options);
    return tenantId
      ? { kind: "tenant", capability: "tenant-admin", tenantId, credentialId: "operator-session" }
      : undefined;
  }
  const token = tokenForScope(options, scope);
  if (!token) {
    if (scope === "operator") {
      return operatorPrincipal;
    }
    const hasRuntimeTokens = options.hasRuntimeTokens
      ? await options.hasRuntimeTokens()
      : options.resolveRuntimeToken !== undefined;
    if (!hasRuntimeTokens && !options.verifyRuntimeJwt && !options.sharedRuntime) {
      return {
        kind: "tenant",
        capability: "runtime",
        tenantId: compatibilityTenantId,
        runtimeTokenId: "local-open",
      };
    }
    return resolveRuntimePrincipal(context, options);
  }

  if (await hasRequestToken(context, token)) {
    return scope === "operator"
      ? operatorPrincipal
      : { kind: "tenant", capability: "runtime", tenantId: compatibilityTenantId, runtimeTokenId: "bootstrap" };
  }

  return scope === "runtime" ? await resolveRuntimePrincipal(context, options) : undefined;
}

async function hasRequestToken(context: Context, token: string): Promise<boolean> {
  return matchesConfiguredToken(context, token) || (await hasValidAuthCookie(context, token));
}

async function hasValidAuthCookie(context: Context, token: string): Promise<boolean> {
  const cookie = getCookie(context, authCookieName);
  if (!cookie) {
    return false;
  }

  const [version, issuedAt, nonce, signature, ...extra] = cookie.split(".");
  if (version !== authCookieVersion || !issuedAt || !nonce || !signature || extra.length > 0) {
    return false;
  }

  const issuedAtMs = Number(issuedAt);
  if (!Number.isFinite(issuedAtMs) || issuedAtMs > Date.now() || Date.now() - issuedAtMs > authCookieMaxAgeMs) {
    return false;
  }

  const payload = `${version}.${issuedAt}.${nonce}`;
  return constantTimeEqual(signature, await signAuthCookiePayload(payload, token));
}

async function createAuthCookieValue(token: string): Promise<string> {
  const payload = `${authCookieVersion}.${Date.now()}.${base64Url(crypto.getRandomValues(new Uint8Array(16)))}`;
  return `${payload}.${await signAuthCookiePayload(payload, token)}`;
}

async function readOperatorTenantSession(context: Context, options: LocalAuthOptions): Promise<TenantId | undefined> {
  if (!options.sharedRuntime || !(await isOperatorAuthenticated(context, options))) {
    return undefined;
  }
  const cookie = getCookie(context, tenantSessionCookieName);
  if (!cookie) {
    return undefined;
  }

  const [version, issuedAt, tenantIdInput, nonce, signature, ...extra] = cookie.split(".");
  if (
    version !== tenantSessionCookieVersion ||
    !issuedAt ||
    !tenantIdInput ||
    !nonce ||
    !signature ||
    extra.length > 0
  ) {
    return undefined;
  }
  const issuedAtMs = Number(issuedAt);
  if (!Number.isFinite(issuedAtMs) || issuedAtMs > Date.now() || Date.now() - issuedAtMs > tenantSessionMaxAgeMs) {
    return undefined;
  }
  let tenantId: TenantId;
  try {
    tenantId = parseTenantId(tenantIdInput);
  } catch {
    return undefined;
  }
  const payload = `${version}.${issuedAt}.${tenantId}.${nonce}`;
  if (
    !constantTimeEqual(signature, await signAuthCookiePayload(`tenant.${payload}`, tenantSessionSigningSecret(options)))
  ) {
    return undefined;
  }
  return (await isTenantActive(options, tenantId)) ? tenantId : undefined;
}

async function isOperatorAuthenticated(context: Context, options: LocalAuthOptions): Promise<boolean> {
  const token = normalizeToken(options.adminToken);
  return token ? await hasRequestToken(context, token) : true;
}

function tenantSessionSigningSecret(options: LocalAuthOptions): string {
  const configured = normalizeToken(options.adminToken);
  if (configured) {
    return configured;
  }
  let secret = tenantSessionSecrets.get(options);
  if (!secret) {
    secret = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    tenantSessionSecrets.set(options, secret);
  }
  return secret;
}

async function signAuthCookiePayload(payload: string, token: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", utf8(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(await crypto.subtle.sign("HMAC", key, utf8(payload)));
}

function utf8(value: string): ArrayBuffer {
  return new TextEncoder().encode(value).buffer as ArrayBuffer;
}

function base64Url(value: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(bytes).toString("base64url");
}

// Deployment secrets (`OOMOL_CONNECT_ADMIN_TOKEN` / `OOMOL_CONNECT_RUNTIME_TOKEN`) are long-lived,
// so the credential is compared in constant time instead of with `===`, which short-circuits on the
// first differing character and leaks how much of the token an attacker already guessed. Stored
// runtime tokens already get the same treatment through `timingSafeEqual` on their hashes.
function matchesConfiguredToken(context: Context, token: string): boolean {
  return constantTimeEqual(readBearerCredential(context), token);
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function normalizeToken(token: string | undefined): string | undefined {
  const value = token?.trim();
  return value ? value : undefined;
}

function readAuthScope(path: string): AuthScope {
  if (path.startsWith("/api/tenant")) return "tenant-admin";
  if (path === "/api/files" || path.startsWith("/api/files/")) return "tenant";
  return path === "/mcp" || path.startsWith("/mcp/") || path === "/v1" || path.startsWith("/v1/")
    ? "runtime"
    : "operator";
}

function canUseAdminAuth(path: string, method: string): boolean {
  return method === "POST" && /^\/v1\/actions\/[^/]+$/.test(path);
}

function tokenForScope(options: LocalAuthOptions, scope: AuthScope): string | undefined {
  const adminToken = normalizeToken(options.adminToken);
  const runtimeToken = normalizeToken(options.runtimeToken);
  return scope === "runtime" ? runtimeToken : scope === "operator" ? adminToken : undefined;
}

async function resolveRuntimePrincipal(
  context: Context,
  options: LocalAuthOptions,
): Promise<AuthenticatedPrincipal | undefined> {
  const token = readBearerToken(context);
  if (!token) {
    return undefined;
  }
  const grant = await options.resolveRuntimeToken?.(token);
  if (grant && (await isTenantActive(options, grant.tenantId))) {
    runtimeGrants.set(context.req.raw, grant);
    return {
      kind: "tenant",
      capability: "runtime",
      tenantId: grant.tenantId,
      runtimeTokenId: grant.tokenId,
    };
  }
  const verified = await options.verifyRuntimeJwt?.(token);
  if (verified === true) {
    if (!(await isTenantActive(options, compatibilityTenantId))) return undefined;
    return {
      kind: "tenant",
      capability: "runtime",
      tenantId: compatibilityTenantId,
      runtimeTokenId: "jwt:legacy",
    };
  }
  if (!verified || !(await isTenantActive(options, verified.tenantId))) return undefined;
  return verified;
}

async function isTenantActive(options: LocalAuthOptions, tenantId: typeof compatibilityTenantId): Promise<boolean> {
  return options.tenantCredentials ? await options.tenantCredentials.isTenantActive(tenantId) : true;
}

function readBearerToken(context: Context): string | undefined {
  return normalizeToken(readBearerCredential(context));
}

/**
 * Bearer credential exactly as sent, so configured tokens still require a byte-for-byte match.
 *
 * Authentication schemes are case-insensitive (RFC 9110), so `bearer` and `BEARER` are accepted;
 * only the credentials stay case-sensitive.
 */
function readBearerCredential(context: Context): string {
  const authorization = context.req.header("authorization") ?? "";
  const separator = authorization.indexOf(" ");
  if (separator < 0 || authorization.slice(0, separator).toLowerCase() !== bearerScheme) {
    return "";
  }

  return authorization.slice(separator + 1);
}
