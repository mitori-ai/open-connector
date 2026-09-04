import type { ConnectionService } from "../connection-service.ts";
import type { TenantId } from "../core/tenant.ts";
import type { ISecretCodec } from "../server/secrets/secret-codec-core.ts";
import type {
  OAuthClientConfig,
  OAuthClientConfigInput,
  OAuthClientConfigService,
} from "./oauth-client-config-service.ts";

import { createHash, randomBytes } from "node:crypto";
import { defaultConnectionName } from "../connection-service.ts";
import { normalizeSlackAuthorizationCredential } from "../providers/slack/oauth.ts";
import { requestAuthorizationCodeToken } from "./oauth-token.ts";

/**
 * Started OAuth authorization flow returned to the local console.
 */
export type OAuthAuthorizationStart = {
  authorizationUrl: string;
  state: string;
  returnUrl?: string;
};

export interface OAuthAuthorizationStartInput {
  tenantId: TenantId;
  service: string;
  connectionName?: string;
  sessionCorrelation: string;
  returnUrl?: string;
  clientConfig?: OAuthClientConfigInput;
  /** Declared OAuth scope subset for this connection only. */
  requestedScopes?: string[];
}

export interface OAuthAuthorizationCompleteInput {
  completionCapability: string;
  sessionCorrelation: string;
  tenantId: TenantId;
}

/**
 * Short-lived OAuth state stored while the browser completes authorization.
 */
export interface OAuthAuthorizationState {
  tenantId: TenantId;
  service: string;
  connectionName?: string;
  state: string;
  createdAt: string;
  sessionCorrelation: string;
  authorizationCode?: string;
  providerState?: string;
  pkceCodeVerifier?: string;
  clientConfig?: OAuthClientConfig;
  /** Exact allowlisted completion URL bound to this one-time state. */
  returnUrl?: string;
}

export interface OAuthFlowServiceOptions {
  clientConfigs: OAuthClientConfigService;
  connections: ConnectionService;
  states: IOAuthStateStore;
  stateMaxAgeMs?: number;
  secretCodec: ISecretCodec;
  isCustomClientConfigAllowed?: (service: string) => boolean;
}

/**
 * Storage contract for pending OAuth authorization states.
 */
export interface IOAuthStateStore {
  set(state: OAuthAuthorizationState): Promise<void>;
  take(state: string): Promise<OAuthAuthorizationState | undefined>;
}

/**
 * Coordinates runtime OAuth authorization and token exchange.
 */
export class OAuthFlowService {
  private readonly clientConfigs: OAuthClientConfigService;
  private readonly connections: ConnectionService;
  private readonly states: IOAuthStateStore;
  private readonly stateMaxAgeMs: number;
  private readonly secretCodec: ISecretCodec;
  private readonly isCustomClientConfigAllowed: (service: string) => boolean;

  constructor(input: OAuthFlowServiceOptions) {
    this.clientConfigs = input.clientConfigs;
    this.connections = input.connections;
    this.states = input.states;
    this.stateMaxAgeMs = input.stateMaxAgeMs ?? 15 * 60 * 1000;
    this.secretCodec = input.secretCodec;
    this.isCustomClientConfigAllowed = input.isCustomClientConfigAllowed ?? (() => false);
  }

  async startAuthorization(input: OAuthAuthorizationStartInput): Promise<OAuthAuthorizationStart> {
    const { service, returnUrl, tenantId } = input;
    if (input.sessionCorrelation.length < 16 || input.sessionCorrelation.length > 256) {
      throw new OAuthFlowError("invalid_input", "sessionCorrelation must contain 16-256 characters.");
    }
    const connectionName = input.connectionName ?? defaultConnectionName;
    this.connections.assertProviderAvailable(service);
    const auth = this.clientConfigs.getOAuthDefinition(service);
    let config = input.clientConfig
      ? this.resolveCustomClientConfig(service, input.clientConfig)
      : await this.clientConfigs.getConfig(service);
    if (!config) {
      throw new OAuthFlowError("oauth_client_config_required", `Configure an OAuth client for ${service} first.`);
    }
    if (input.requestedScopes) {
      config = this.clientConfigs.withRequestedScopes(service, config, input.requestedScopes);
    }

    const state = crypto.randomUUID();
    const pkceCodeVerifier = auth.pkce ? createPkceCodeVerifier() : undefined;
    await this.states.set({
      tenantId,
      service,
      connectionName,
      state,
      createdAt: new Date().toISOString(),
      sessionCorrelation: input.sessionCorrelation,
      pkceCodeVerifier,
      // Persist the effective config when this authorization narrows scopes so
      // the callback cannot silently fall back to a changed shared config.
      clientConfig: input.clientConfig || input.requestedScopes ? config : undefined,
      returnUrl,
    });

    const authorizationUrl = new URL(this.clientConfigs.resolveEndpointUrl(service, auth.authorizationUrl, config));
    for (const [key, value] of Object.entries(auth.authorizationParams ?? {})) {
      authorizationUrl.searchParams.set(key, value);
    }
    setAuthorizationParam(authorizationUrl, auth.authorizationRequestFields?.clientId, "client_id", config.clientId);
    setAuthorizationParam(
      authorizationUrl,
      auth.authorizationRequestFields?.redirectUri,
      "redirect_uri",
      this.clientConfigs.expectedRedirectUri(service),
    );
    setAuthorizationParam(authorizationUrl, auth.authorizationRequestFields?.responseType, "response_type", "code");
    setAuthorizationParam(authorizationUrl, auth.authorizationRequestFields?.state, "state", state);
    const effectiveScopes = this.clientConfigs.getEffectiveScopes(service, config);
    if (effectiveScopes.length > 0 && auth.authorizationRequestFields?.scope !== false) {
      authorizationUrl.searchParams.set(
        auth.authorizationRequestFields?.scope ?? "scope",
        effectiveScopes.join(auth.scopeSeparator ?? " "),
      );
    }
    if (pkceCodeVerifier) {
      authorizationUrl.searchParams.set("code_challenge", createPkceCodeChallenge(pkceCodeVerifier));
      authorizationUrl.searchParams.set("code_challenge_method", auth.pkce?.method ?? "S256");
    }

    return { authorizationUrl: authorizationUrl.toString(), state, returnUrl };
  }

  async consumeAuthorizationState(state: string): Promise<OAuthAuthorizationState> {
    const pending = await this.states.take(state);
    if (!pending || isExpiredOAuthState(pending, this.stateMaxAgeMs)) {
      throw new OAuthFlowError("invalid_oauth_state", "OAuth state is missing or expired.", pending);
    }
    return pending;
  }

  async stageAuthorization(
    state: string,
    code: string,
  ): Promise<{ completionCapability: string; returnUrl?: string; service: string }> {
    const pending = await this.consumeAuthorizationState(state);
    const completionId = crypto.randomUUID();
    await this.states.set({
      ...pending,
      state: completionId,
      providerState: pending.state,
      authorizationCode: code,
    });
    const completionCapability = await this.createCompletionCapability({
      completionId,
      tenantId: pending.tenantId,
      connectionName: pending.connectionName!,
      sessionCorrelation: pending.sessionCorrelation,
    });
    return { completionCapability, returnUrl: pending.returnUrl, service: pending.service };
  }

  async completeAuthorization(
    input: OAuthAuthorizationCompleteInput,
  ): Promise<{ service: string; connected: true; returnUrl?: string }> {
    const capability = await this.readCompletionCapability(input.completionCapability);
    if (capability.tenantId !== input.tenantId || capability.sessionCorrelation !== input.sessionCorrelation) {
      throw new OAuthFlowError("invalid_oauth_session", "OAuth completion tenant or session does not match.");
    }
    const pending = await this.consumeAuthorizationState(capability.completionId);
    if (
      pending.tenantId !== capability.tenantId ||
      pending.connectionName !== capability.connectionName ||
      pending.sessionCorrelation !== capability.sessionCorrelation ||
      !pending.authorizationCode
    ) {
      throw new OAuthFlowError("invalid_oauth_session", "OAuth completion identity does not match.", pending);
    }
    return this.finishAuthorization(pending, pending.authorizationCode);
  }

  /** Single-user compatibility path. Shared runtimes must use staged tenant-admin completion. */
  async completeLocalAuthorization(
    state: string,
    code: string,
  ): Promise<{ service: string; connected: true; returnUrl?: string }> {
    return this.finishAuthorization(await this.consumeAuthorizationState(state), code);
  }

  private async finishAuthorization(
    pending: OAuthAuthorizationState,
    code: string,
  ): Promise<{ service: string; connected: true; returnUrl?: string }> {
    try {
      const auth = this.clientConfigs.getOAuthDefinition(pending.service);
      const config = pending.clientConfig ?? (await this.clientConfigs.getConfig(pending.service));
      if (!config) {
        throw new OAuthFlowError(
          "oauth_client_config_required",
          `Configure an OAuth client for ${pending.service} first.`,
        );
      }

      let tokenResponse = await requestAuthorizationCodeToken({
        code,
        state: pending.providerState ?? pending.state,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: this.clientConfigs.expectedRedirectUri(pending.service),
        responseEnvelope: auth.tokenResponseEnvelope,
        tokenRequestFields: auth.tokenRequestFields,
        tokenEndpointAuthMethod: auth.tokenEndpointAuthMethod,
        tokenRequestFormat: auth.tokenRequestFormat,
        tokenUrl: this.clientConfigs.resolveEndpointUrl(pending.service, auth.tokenUrl, config),
        extraFields: createTokenExtraFields(pending),
        createError: (message) => new OAuthFlowError("oauth_token_exchange_failed", message, pending),
      });
      if (pending.service === "slack") {
        tokenResponse = normalizeSlackAuthorizationCredential(tokenResponse);
      }
      const oauthCredential = {
        ...tokenResponse,
        metadata: {
          ...tokenResponse.metadata,
          oauthClientId: config.clientId,
          oauthClientExtra: config.extra,
          oauthClientSecretExtra: config.secretExtra,
          oauthClientConfig: pending.clientConfig ? config : undefined,
        },
      };

      await this.connections.setOAuthCredential(
        pending.service,
        oauthCredential,
        pending.connectionName,
        pending.tenantId,
      );
      return { service: pending.service, connected: true, returnUrl: pending.returnUrl };
    } catch (error) {
      if (error instanceof OAuthFlowError) {
        throw error.returnUrl === pending.returnUrl ? error : new OAuthFlowError(error.code, error.message, pending);
      }
      if (error instanceof Error && "code" in error && typeof error.code === "string") {
        throw new OAuthFlowError(error.code, error.message, pending);
      }
      throw error;
    }
  }

  private resolveCustomClientConfig(service: string, input: OAuthClientConfigInput): OAuthClientConfig {
    if (!this.isCustomClientConfigAllowed(service)) {
      throw new OAuthFlowError(
        "oauth_custom_app_not_allowed",
        `Custom OAuth apps are not enabled for ${service} on this runtime.`,
      );
    }
    if (!this.secretCodec?.encrypted) {
      throw new OAuthFlowError(
        "oauth_custom_app_encryption_required",
        "Configure OOMOL_CONNECT_ENCRYPTION_KEY before using a custom OAuth app.",
      );
    }
    return this.clientConfigs.normalizeConfig(service, input);
  }

  private async createCompletionCapability(input: OAuthCompletionCapability): Promise<string> {
    const encoded = await this.secretCodec.encode(JSON.stringify({ version: 1, ...input }));
    return Buffer.from(encoded, "utf8").toString("base64url");
  }

  private async readCompletionCapability(value: string): Promise<OAuthCompletionCapability> {
    if (!value) {
      throw new OAuthFlowError("invalid_oauth_session", "OAuth completion session is missing.");
    }
    try {
      const stored = Buffer.from(value, "base64url").toString("utf8");
      const parsed = JSON.parse(await this.secretCodec.decode(stored)) as Partial<OAuthCompletionCapability> & {
        version?: number;
      };
      if (
        parsed.version !== 1 ||
        typeof parsed.completionId !== "string" ||
        typeof parsed.tenantId !== "string" ||
        typeof parsed.connectionName !== "string" ||
        typeof parsed.sessionCorrelation !== "string"
      ) {
        throw new Error("invalid capability");
      }
      return {
        completionId: parsed.completionId,
        tenantId: parsed.tenantId as TenantId,
        connectionName: parsed.connectionName,
        sessionCorrelation: parsed.sessionCorrelation,
      };
    } catch {
      throw new OAuthFlowError("invalid_oauth_session", "OAuth completion session is invalid.");
    }
  }
}

interface OAuthCompletionCapability {
  completionId: string;
  tenantId: TenantId;
  connectionName: string;
  sessionCorrelation: string;
}

function setAuthorizationParam(
  url: URL,
  fieldName: string | false | undefined,
  defaultFieldName: string,
  value: string,
): void {
  if (fieldName !== false) {
    url.searchParams.set(fieldName ?? defaultFieldName, value);
  }
}

function createTokenExtraFields(state: OAuthAuthorizationState): Record<string, string> | undefined {
  if (!state.pkceCodeVerifier) {
    return undefined;
  }

  return {
    code_verifier: state.pkceCodeVerifier,
  };
}

function isExpiredOAuthState(state: OAuthAuthorizationState, maxAgeMs: number): boolean {
  const createdAt = Date.parse(state.createdAt);
  return !Number.isFinite(createdAt) || Date.now() - createdAt > maxAgeMs;
}

function createPkceCodeVerifier(): string {
  return encodeBase64Url(randomBytes(48));
}

function createPkceCodeChallenge(codeVerifier: string): string {
  return encodeBase64Url(createHash("sha256").update(codeVerifier).digest());
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * Error with a stable code suitable for HTTP responses.
 */
export class OAuthFlowError extends Error {
  readonly code: string;
  readonly returnUrl?: string;

  constructor(code: string, message: string, state?: OAuthAuthorizationState) {
    super(message);
    this.code = code;
    this.returnUrl = state?.returnUrl;
  }
}
