import type { CatalogStore } from "../catalog-store.ts";
import type { ActionPolicyService } from "../core/action-policy.ts";
import type { TenantId } from "../core/tenant.ts";
import type { IProviderLoader } from "../providers/provider-loader.ts";
import type { RuntimeJwtVerifier } from "./api/runtime-jwt.ts";
import type { ITransitFileService, TransitFileUpload } from "./files/transit-file-store.ts";
import type { Logger } from "./logger.ts";
import type { ISecretCodec } from "./secrets/secret-codec-core.ts";
import type { RuntimeDatabase } from "./storage/runtime-database.ts";
import type { Hono } from "hono";

import { ConnectionService } from "../connection-service.ts";
import { OAuthClientConfigService } from "../oauth/oauth-client-config-service.ts";
import { OAuthCredentialRefreshService } from "../oauth/oauth-credential-refresh-service.ts";
import { OAuthFlowService } from "../oauth/oauth-flow-service.ts";
import { ActionRunner } from "./actions/action-runner.ts";
import { ConnectServer } from "./connect-server.ts";
import { RuntimeTokenService } from "./storage/runtime-token-service.ts";
import { TenantCredentialService } from "./storage/tenant-credential-service.ts";

export interface ConnectAppOptions {
  catalog: CatalogStore;
  providerLoader: IProviderLoader;
  runtimeDatabase: RuntimeDatabase;
  transitFiles: ITransitFileService;
  uploadTransitFile?: (request: Request, tenantId?: TenantId) => Promise<TransitFileUpload>;
  publicOrigin: string;
  secretCodec: ISecretCodec;
  adminToken?: string;
  runtimeToken?: string;
  sharedRuntime?: boolean;
  allowedCustomOAuth?: string[];
  allowedOAuthReturnUrlOrigins?: string[];
  verifyRuntimeJwt?: RuntimeJwtVerifier;
  actionPolicy?: ActionPolicyService;
  registerStaticRoutes?: (app: Hono) => void;
  logger?: Logger;
  computeRuntimeAuthConfigured?: boolean;
  compressApiResponses?: boolean;
}

export interface ConnectApp {
  app: Hono;
  runtimeAuthConfigured: boolean;
}

export async function createConnectApp(options: ConnectAppOptions): Promise<ConnectApp> {
  if (options.sharedRuntime && !options.secretCodec.encrypted) {
    throw new Error("Shared runtime OAuth completion requires OOMOL_CONNECT_ENCRYPTION_KEY.");
  }
  const allowedCustomOAuth = new Set(options.allowedCustomOAuth);
  const isCustomClientConfigAllowed = (service: string): boolean =>
    allowedCustomOAuth.has("*") || allowedCustomOAuth.has(service);
  const oauthClientConfigs = new OAuthClientConfigService({
    catalog: options.catalog,
    origin: options.publicOrigin,
    store: options.runtimeDatabase.oauthClientConfigStore,
    isCustomClientConfigAvailable: (service) => options.secretCodec.encrypted && isCustomClientConfigAllowed(service),
  });
  const connections = new ConnectionService({
    catalog: options.catalog,
    oauthCredentials: new OAuthCredentialRefreshService(oauthClientConfigs),
    providerLoader: options.providerLoader,
    store: options.runtimeDatabase.connectionStore,
    logger: options.logger,
  });
  const runtimeTokens = new RuntimeTokenService(
    options.runtimeDatabase.runtimeTokenStore,
    options.runtimeDatabase.connectionStore,
    options.logger,
  );
  const tenantCredentials = new TenantCredentialService(options.runtimeDatabase.tenantCredentialStore, options.logger);
  const hasStoredRuntimeTokens = (): Promise<boolean> => runtimeTokens.hasTokens();
  const hasTenantAdminCredentials = (): Promise<boolean> => tenantCredentials.hasAdminCredentials();
  const actions = new ActionRunner({
    catalog: options.catalog,
    providerLoader: options.providerLoader,
    connections,
    runs: options.runtimeDatabase.runLogStore,
    transitFiles: options.transitFiles,
    actionPolicy: options.actionPolicy,
    logger: options.logger,
  });
  const hasInitialRuntimeAuth = Boolean(options.verifyRuntimeJwt) || (await hasStoredRuntimeTokens());
  if (options.sharedRuntime && !hasInitialRuntimeAuth) {
    throw new Error(
      "Shared runtime authentication is not ready; configure tenant-claim JWT authentication or create an active stored runtime token before startup.",
    );
  }

  return {
    app: new ConnectServer({
      catalog: options.catalog,
      providerLoader: options.providerLoader,
      connections,
      oauthClientConfigs,
      oauthFlow: new OAuthFlowService({
        clientConfigs: oauthClientConfigs,
        connections,
        states: options.runtimeDatabase.oauthStateStore,
        secretCodec: options.secretCodec,
        isCustomClientConfigAllowed,
      }),
      actions,
      idempotency: options.runtimeDatabase.idempotencyStore,
      transitFiles: options.transitFiles,
      uploadTransitFile: options.uploadTransitFile,
      runtimeTokens,
      tenantCredentials,
      runtimePolicyStore: options.runtimeDatabase.runtimePolicyStore,
      allowedOAuthReturnUrlOrigins: options.allowedOAuthReturnUrlOrigins,
      registerStaticRoutes: options.registerStaticRoutes,
      auth: {
        adminToken: options.adminToken,
        runtimeToken: options.runtimeToken,
        sharedRuntime: options.sharedRuntime,
        hasRuntimeTokens: hasStoredRuntimeTokens,
        hasTenantAdminCredentials,
        resolveRuntimeToken: (token) => runtimeTokens.resolveToken(token),
        tenantCredentials,
        verifyRuntimeJwt: options.verifyRuntimeJwt,
      },
      actionPolicy: options.actionPolicy,
      logger: options.logger,
      compressApiResponses: options.compressApiResponses,
    }).createApp(),
    runtimeAuthConfigured:
      Boolean(options.runtimeToken) ||
      Boolean(options.verifyRuntimeJwt) ||
      (options.computeRuntimeAuthConfigured === false ? false : hasInitialRuntimeAuth),
  };
}
