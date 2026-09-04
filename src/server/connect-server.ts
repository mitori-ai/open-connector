import type { CatalogStore, RuntimeActionDefinition } from "../catalog-store.ts";
import type { ConnectionService, ConnectionSummary } from "../connection-service.ts";
import type { ActionPolicySnapshot } from "../core/action-policy.ts";
import type { ActionSearchIndexProvider, ActionSearchResult } from "../core/action-search.ts";
import type { TenantId } from "../core/tenant.ts";
import type { OAuthClientConfigInput } from "../oauth/oauth-client-config-service.ts";
import type { IProviderLoader } from "../providers/provider-loader.ts";
import type { LocalAuthOptions } from "./api/auth.ts";
import type { RuntimeActionHttpResult } from "./api/runtime-api.ts";
import type { ITransitFileService, TransitFileUpload } from "./files/transit-file-store.ts";
import type { Logger } from "./logger.ts";
import type { IIdempotencyStore } from "./storage/idempotency-store.ts";
import type { IRuntimePolicyStore } from "./storage/runtime-policy-store.ts";
import type { RunLogCaller, RunLogListInput } from "./storage/runtime-store.ts";
import type { RuntimeGrant, RuntimeTokenService } from "./storage/runtime-token-service.ts";
import type { TenantCredentialService } from "./storage/tenant-credential-service.ts";
import type { Context } from "hono";

import { createMcpHandler } from "@modelcontextprotocol/server";
import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { ConnectionError, defaultConnectionName } from "../connection-service.ts";
import { ActionPolicyService, emptyPolicyRules } from "../core/action-policy.ts";
import { DEFAULT_ACTION_SEARCH_LIMIT, createActionSearchIndexProvider, searchActions } from "../core/action-search.ts";
import { optionalRecord, optionalString, requiredString, requiredStringArray } from "../core/cast.ts";
import { compatibilityTenantId, parseTenantId } from "../core/tenant.ts";
import { createMcpServer, listMcpToolSummaries } from "../mcp.ts";
import { OAuthClientConfigError, OAuthClientConfigService } from "../oauth/oauth-client-config-service.ts";
import { OAuthFlowError, OAuthFlowService } from "../oauth/oauth-flow-service.ts";
import {
  ActionInputDepthError,
  createIdempotencyExpiry,
  hashActionRequest,
  hashIdempotencyKey,
  readIdempotencyKey,
} from "./actions/action-idempotency.ts";
import { ActionRunner } from "./actions/action-runner.ts";
import { renderActionMarkdown } from "./api/action-markdown.ts";
import {
  clearLocalAuthCookie,
  createLocalAuthMiddleware,
  readAuthenticatedPrincipal,
  readLocalAuthSession,
  readRuntimeGrant,
} from "./api/auth.ts";
import { getResponseCachePolicy } from "./api/cache-policy.ts";
import { HttpRequestError, internalError, jsonError, notFound, readJsonBody } from "./api/http-utils.ts";
import { renderOAuthCompletionPage } from "./api/oauth-completion-page.ts";
import { createOpenApiDocument } from "./api/openapi.ts";
import { policyRequestMaxBytes, readRuntimePolicyRules, readTokenPolicy } from "./api/policy-input.ts";
import {
  mapConnectionErrorStatus,
  serializeRuntimeAction,
  serializeRuntimeActionResult,
  serializeRuntimeActionService,
  serializeRuntimeConnectedApp,
  serializeRuntimeFailure,
  serializeRuntimeProvider,
  serializeRuntimePrincipal,
  unknownActionFailure,
  writeRuntimeActionHttpResult,
  writeRuntimeFailure,
  writeRuntimeSuccess,
} from "./api/runtime-api.ts";
import { createTransitFileResponse, TransitFileError } from "./files/transit-file-store.ts";
import { ProxyRunner } from "./proxy/proxy-runner.ts";
import { decodeRunLogCursor } from "./storage/runtime-store.ts";
import { RuntimeTokenPolicyError, summarizeRuntimeToken } from "./storage/runtime-token-service.ts";

/**
 * Dependencies required to construct the local connector server.
 */
export interface IConnectServerOptions {
  catalog: CatalogStore;
  providerLoader: IProviderLoader;
  connections: ConnectionService;
  oauthClientConfigs: OAuthClientConfigService;
  oauthFlow: OAuthFlowService;
  runtimeTokens: RuntimeTokenService;
  tenantCredentials?: TenantCredentialService;
  actions: ActionRunner;
  idempotency: IIdempotencyStore;
  transitFiles: ITransitFileService;
  uploadTransitFile?: (request: Request, tenantId?: TenantId) => Promise<TransitFileUpload>;
  staticRoot?: string;
  auth?: LocalAuthOptions;
  actionPolicy?: ActionPolicyService;
  runtimePolicyStore: IRuntimePolicyStore;
  actionSearch?: ActionSearchIndexProvider;
  /** Exact origins permitted for OAuth completion return URLs. */
  allowedOAuthReturnUrlOrigins?: string[];
  registerStaticRoutes?: (app: Hono) => void;
  logger?: Logger;
  compressApiResponses?: boolean;
}

/**
 * Local single-user HTTP server for catalog browsing, credential management,
 * action execution, OpenAPI docs, and MCP tool metadata.
 */
export class ConnectServer {
  private readonly options: IConnectServerOptions;
  private readonly actionSearch: ActionSearchIndexProvider;
  private readonly actionPolicy: ActionPolicyService;
  private readonly proxyRunner: ProxyRunner;
  private readonly policySnapshots = new WeakMap<Request, Promise<ActionPolicySnapshot>>();

  constructor(options: IConnectServerOptions) {
    this.options = options;
    this.actionSearch = options.actionSearch ?? createActionSearchIndexProvider(options.catalog.actions);
    this.actionPolicy = options.actionPolicy ?? new ActionPolicyService();
    this.proxyRunner = new ProxyRunner({
      catalog: options.catalog,
      providerLoader: options.providerLoader,
      connections: options.connections,
      actionPolicy: this.actionPolicy,
      logger: options.logger,
    });
  }

  createApp(): Hono {
    const app = new Hono();
    const auth = this.options.auth ?? {};

    app.use("*", async (context, next) => {
      await next();
      const cachePolicy = getResponseCachePolicy(context.req.method, context.req.path, context.res.status);
      if (cachePolicy) {
        context.header("Cache-Control", cachePolicy.cacheControl);
        if (cachePolicy.cloudflareCdnCacheControl) {
          context.header("Cloudflare-CDN-Cache-Control", cachePolicy.cloudflareCdnCacheControl);
        }
        if (cachePolicy.vary) {
          context.header("Vary", cachePolicy.vary);
        }
      }
    });
    app.get("/health", (context) => context.json({ ok: true }));
    if (this.options.compressApiResponses !== false) {
      // Compress dashboard JSON responses. Scoped to /api/* so the streaming
      // /mcp transport and /v1/proxy pass-through are never buffered/re-encoded.
      // The middleware's content-type filter already skips non-text bodies
      // (e.g. transit file downloads).
      app.use("/api/*", compress());
    }
    app.use("*", createLocalAuthMiddleware(auth));
    app.get("/v1/health", (context) => writeRuntimeSuccess(context, { ok: true, runtime: "oomol-connect" }));
    app.get("/v1/principal", (context) => this.getRuntimePrincipal(context));
    app.get("/v1/providers", (context) => this.listRuntimeProviders(context));
    app.get("/v1/actions", (context) => this.listRuntimeActions(context));
    app.get("/v1/actions/search", (context) => this.searchRuntimeActions(context));
    app.get("/v1/actions/:actionId", (context) => this.getRuntimeAction(context, context.req.param("actionId")));
    app.post("/v1/actions/:actionId", (context) => this.createRuntimeActionRun(context, context.req.param("actionId")));
    app.get("/v1/apps", (context) => this.listRuntimeApps(context));
    app.get("/v1/apps/authenticated", (context) => this.listAuthenticatedRuntimeApps(context));
    app.get("/v1/apps/services/:service", (context) =>
      this.listRuntimeAppsByService(context, context.req.param("service")),
    );
    app.post("/v1/proxy/:service", (context) => this.createRuntimeProxyRequest(context, context.req.param("service")));

    app.get("/openapi.json", (context) =>
      context.json(
        createOpenApiDocument(this.options.catalog.providers, {
          actionId: optionalString(context.req.query("actionId")),
        }),
      ),
    );
    app.get(
      "/docs",
      Scalar({
        pageTitle: "OOMOL Connect API Reference",
        url: "/openapi.json",
        theme: "default",
        darkMode: false,
        forceDarkModeState: "light",
        customCss: `
          :root {
            --scalar-color-accent: rgb(59, 99, 251);
            --scalar-background-accent: rgba(59, 99, 251, 0.12);
          }
        `,
      }),
    );

    // Schema-free listing. The action detail view loads full schemas on demand
    // from /api/actions/:actionId. The catalog is immutable at runtime, so the
    // body and its ETag are precomputed and reused, and unchanged reloads get a
    // 304 instead of re-downloading the payload.
    app.get("/api/providers", (context) => this.listProviderSummaries(context));
    app.get("/api/providers/:service", (context) => this.getProvider(context, context.req.param("service")));

    app.get("/api/actions", (context) => context.json(this.options.catalog.actions));
    app.get("/api/actions/search", (context) => this.searchApiActions(context));
    app.get("/api/actions/:actionId/agent.md", (context) =>
      this.getActionMarkdown(context, context.req.param("actionId")),
    );
    app.get("/api/actions/:actionId", (context) => this.getAction(context, context.req.param("actionId")));
    app.get("/api/auth/session", async (context) => context.json(await readLocalAuthSession(context, auth)));
    app.post("/api/auth/logout", (context) => {
      clearLocalAuthCookie(context);
      return context.json({ ok: true });
    });

    app.get("/api/connections", (context) => this.listConnections(context));
    app.put("/api/connections/:service", (context) => this.upsertConnection(context, context.req.param("service")));
    app.delete("/api/connections/:service", (context) => this.disconnect(context, context.req.param("service")));

    app.get("/api/runs", (context) => this.listRuns(context));
    app.get("/api/runs/:id", (context) => this.getRun(context, context.req.param("id")));
    app.post("/api/files", (context) => this.createTransitFile(context));
    app.get("/api/files/:fileId", (context) => this.getTransitFile(context, context.req.param("fileId")));
    app.delete("/api/files/:fileId", (context) => this.deleteTransitFile(context, context.req.param("fileId")));
    app.get("/api/runtime-tokens", (context) => this.listRuntimeTokens(context));
    app.post("/api/runtime-tokens", (context) => this.createRuntimeToken(context));
    app.put("/api/runtime-tokens/:id", (context) => this.updateRuntimeToken(context, context.req.param("id")));
    app.delete("/api/runtime-tokens/:id", (context) => this.revokeRuntimeToken(context, context.req.param("id")));

    app.get("/api/tenant/context", (context) => this.getTenantContext(context));
    app.get("/api/tenant/connections", (context) => this.listConnections(context));
    app.put("/api/tenant/connections/:service", (context) =>
      this.upsertConnection(context, context.req.param("service")),
    );
    app.delete("/api/tenant/connections/:service", (context) => this.disconnect(context, context.req.param("service")));
    app.get("/api/tenant/runs", (context) => this.listRuns(context));
    app.get("/api/tenant/runs/:id", (context) => this.getRun(context, context.req.param("id")));
    app.get("/api/tenant/runtime-tokens", (context) => this.listRuntimeTokens(context));
    app.post("/api/tenant/runtime-tokens", (context) => this.createRuntimeToken(context));
    app.put("/api/tenant/runtime-tokens/:id", (context) => this.updateRuntimeToken(context, context.req.param("id")));
    app.delete("/api/tenant/runtime-tokens/:id", (context) =>
      this.revokeRuntimeToken(context, context.req.param("id")),
    );
    app.post("/api/tenant/oauth/authorizations", (context) => this.createOAuthAuthorization(context));
    app.post("/api/tenant/oauth/completions", (context) => this.completeTenantOAuth(context));

    app.get("/api/operator/tenants", (context) => this.listTenants(context));
    app.post("/api/operator/tenants", (context) => this.createTenant(context));
    app.post("/api/operator/tenants/:tenantId/admin-credentials", (context) =>
      this.createTenantAdminCredential(context, context.req.param("tenantId")),
    );
    app.get("/api/operator/tenants/:tenantId/admin-credentials", (context) =>
      this.listTenantAdminCredentials(context, context.req.param("tenantId")),
    );
    app.delete("/api/operator/tenants/:tenantId/admin-credentials/:credentialId", (context) =>
      this.revokeTenantAdminCredential(context, context.req.param("tenantId"), context.req.param("credentialId")),
    );
    app.get("/api/runtime-policy", (context) => this.getRuntimePolicy(context));
    app.put("/api/runtime-policy", (context) => this.updateRuntimePolicy(context));
    app.get("/api/oauth/configs", (context) => this.listOAuthConfigs(context));
    app.put("/api/oauth/configs/:service", (context) => this.upsertOAuthConfig(context, context.req.param("service")));
    app.delete("/api/oauth/configs/:service", (context) =>
      this.deleteOAuthConfig(context, context.req.param("service")),
    );
    app.post("/api/oauth/authorizations", (context) => this.createOAuthAuthorization(context));
    app.get("/oauth/callback", (context) => this.completeOAuth(context));
    app.post("/mcp", (context) => this.handleMcp(context));
    app.get("/mcp", (context) => this.rejectMcpMethod(context));
    app.delete("/mcp", (context) => this.rejectMcpMethod(context));
    app.get("/mcp/tools", (context) => context.json({ tools: listMcpToolSummaries() }));

    this.options.registerStaticRoutes?.(app);
    app.onError((error, context) => {
      if (error instanceof RuntimeTokenPolicyError) {
        return jsonError(context, 400, "invalid_connection_grant", error.message);
      }
      if (error instanceof HttpRequestError) {
        if (context.req.path.startsWith("/v1/")) {
          return writeRuntimeFailure(context, {
            status: error.status,
            errorCode: error.code,
            message: error.message,
          });
        }
        return jsonError(context, error.status, error.code, error.message);
      }
      this.options.logger?.error(
        {
          err: error,
          method: context.req.method,
          path: context.req.path,
        },
        "request failed",
      );
      return internalError(context, error);
    });

    return app;
  }

  private listProviderSummaries(context: Context): Response {
    const { providerSummariesJson, providerSummariesEtag } = this.options.catalog;
    context.header("ETag", providerSummariesEtag);
    if (requestMatchesEtag(context.req.header("If-None-Match"), providerSummariesEtag)) {
      return context.body(null, 304);
    }
    return context.body(providerSummariesJson, 200, { "Content-Type": "application/json" });
  }

  private getProvider(context: Context, service: string): Response {
    const provider = this.options.catalog.providers.find((provider) => provider.service === service);
    if (!provider) {
      return notFound(context);
    }

    return context.json(provider);
  }

  private async createTransitFile(context: Context): Promise<Response> {
    try {
      if (this.options.uploadTransitFile) {
        return context.json(await this.options.uploadTransitFile(context.req.raw, this.tenantId(context)));
      }

      const form = await context.req.raw.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return jsonError(context, 400, "invalid_input", "file is required.");
      }
      const upload = await this.options.transitFiles.create(file, this.tenantId(context));
      return context.json(upload);
    } catch (error) {
      return this.handleTransitFileError(context, error);
    }
  }

  private async getTransitFile(context: Context, fileId: string): Promise<Response> {
    try {
      if (this.options.transitFiles.response) {
        return await this.options.transitFiles.response(fileId, this.tenantId(context));
      }

      const file = await this.options.transitFiles.read(fileId, this.tenantId(context));
      return createTransitFileResponse(file);
    } catch (error) {
      return this.handleTransitFileError(context, error);
    }
  }

  private async deleteTransitFile(context: Context, fileId: string): Promise<Response> {
    try {
      const deleted = await this.options.transitFiles.delete(fileId, this.tenantId(context));
      return context.json({ fileId, deleted });
    } catch (error) {
      return this.handleTransitFileError(context, error);
    }
  }

  private handleTransitFileError(context: Context, error: unknown): Response {
    if (error instanceof TransitFileError) {
      return jsonError(context, error.status, error.code, error.message);
    }
    throw error;
  }

  private getAction(context: Context, actionId: string): Response {
    const action = this.options.catalog.actionsById.get(actionId);
    if (!action) {
      return notFound(context);
    }

    return context.json(action);
  }

  private async listRuns(context: Context): Promise<Response> {
    const query = readRunLogListInput(context);
    if (!query.ok) {
      return jsonError(context, 400, "invalid_input", query.message);
    }

    return context.json(await this.options.actions.listRuns(this.tenantId(context), query.input));
  }

  private async getRun(context: Context, id: string): Promise<Response> {
    const run = await this.options.actions.getRun(this.tenantId(context), id);
    return run ? context.json(run) : jsonError(context, 404, "run_not_found", `Run not found: ${id}.`);
  }

  private async searchApiActions(context: Context): Promise<Response> {
    const query = readSearchQuery(context);
    if (!query.ok) {
      return jsonError(context, 400, "invalid_input", query.message);
    }

    const index = await this.actionSearch.get();
    return context.json(
      await this.serializeSearchResults(
        searchActions(index, query.q, {
          service: query.service,
          limit: query.limit,
        }),
        this.tenantId(context),
      ),
    );
  }

  private async getActionMarkdown(context: Context, actionId: string): Promise<Response> {
    const action = this.options.catalog.actionsById.get(actionId);
    if (!action) {
      return notFound(context);
    }

    try {
      const policy = (await this.getPolicySnapshot(context)).evaluate(action);
      return context.text(
        renderActionMarkdown(action, {
          connection: await this.options.connections.getConnectionSummary(
            action.service,
            readConnectionName(context),
            this.tenantId(context),
          ),
          providerPermissions: action.providerPermissions,
          policy,
        }),
        200,
        {
          "content-type": "text/markdown; charset=utf-8",
        },
      );
    } catch (error) {
      if (error instanceof ConnectionError) {
        const status = mapConnectionErrorStatus(error);
        // agent.md uses the admin JSON error envelope; mapConnectionErrorStatus may
        // return 409 for OAuth refresh failures, which jsonError does not accept.
        if (status === 409) {
          return context.json({ error: { code: error.code, message: error.message } }, 409);
        }
        return jsonError(context, status, error.code, error.message);
      }
      throw error;
    }
  }

  private listRuntimeProviders(context: Context): Response {
    const services = context.req.queries("service") ?? [];
    const query = optionalString(context.req.query("q"))?.toLowerCase();
    const providers = this.options.catalog.providers.filter((provider) => {
      if (services.length > 0 && !services.includes(provider.service)) {
        return false;
      }
      if (!query) {
        return true;
      }

      return [provider.service, provider.displayName, provider.categories.join(" "), provider.authTypes.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });

    return writeRuntimeSuccess(context, providers.map(serializeRuntimeProvider));
  }

  private listRuntimeActions(context: Context): Response {
    const service = optionalString(context.req.query("service"));
    if (!service) {
      const services = [...new Set(this.options.catalog.actions.map((action) => action.service))];
      return writeRuntimeSuccess(context, services.map(serializeRuntimeActionService));
    }

    const actions = this.options.catalog.actions.filter((action) => action.service === service);
    return writeRuntimeSuccess(context, actions.map(serializeRuntimeAction));
  }

  private async searchRuntimeActions(context: Context): Promise<Response> {
    const query = readSearchQuery(context, 10);
    if (!query.ok) {
      return writeRuntimeFailure(context, {
        status: 400,
        errorCode: "invalid_input",
        message: query.message,
      });
    }

    const index = await this.actionSearch.get();
    const results = searchActions(index, query.q, {
      service: query.service,
      limit: query.limit,
    });
    return writeRuntimeSuccess(context, await this.serializeSearchResults(results, this.tenantId(context)));
  }

  private async serializeSearchResults(
    results: ActionSearchResult[],
    tenantId: TenantId,
  ): Promise<RuntimeActionSearchResult[]> {
    const authenticated = new Set(
      await this.options.connections.listAuthenticatedServices(
        [...new Set(results.map((result) => result.service))],
        tenantId,
      ),
    );
    return results.flatMap((result) => {
      const action = this.options.catalog.actionsById.get(result.id);
      if (!action) {
        return [];
      }
      return [serializeActionSearchResult(result, action, authenticated.has(action.service))];
    });
  }

  private getRuntimeAction(context: Context, actionId: string): Response {
    const action = this.options.catalog.actionsById.get(actionId);
    if (!action) {
      return writeRuntimeFailure(context, unknownActionFailure(actionId));
    }

    return writeRuntimeSuccess(context, serializeRuntimeAction(action));
  }

  private async createRuntimeActionRun(context: Context, actionId: string): Promise<Response> {
    const action = this.options.catalog.actionsById.get(actionId);
    if (!action) {
      return writeRuntimeFailure(context, unknownActionFailure(actionId));
    }

    const body = await readJsonBody(context);
    const input = body.input ?? {};
    const connectionName = readConnectionName(context, body);
    const runtimeGrant = readRuntimeGrant(context);
    const tenantId = this.tenantId(context);
    let policy: ActionPolicySnapshot;
    try {
      policy = await this.getPolicySnapshot(context);
    } catch {
      return writeRuntimeFailure(context, {
        status: 500,
        errorCode: "internal_error",
        message: "Runtime policy is unavailable.",
        meta: { actionId },
      });
    }
    if (!policy.evaluate(action).allowed) {
      return writeRuntimeActionHttpResult(
        context,
        await this.executeRuntimeAction(
          actionId,
          input,
          connectionName,
          policy,
          runtimeGrant,
          tenantId,
          context.req.raw.signal,
        ),
      );
    }
    const idempotencyKey = readIdempotencyKey(context.req.header("idempotency-key"));
    if (!idempotencyKey.ok) {
      return writeRuntimeFailure(context, {
        status: 400,
        errorCode: "invalid_input",
        message: idempotencyKey.message,
        meta: { actionId },
      });
    }

    if (!idempotencyKey.key) {
      return writeRuntimeActionHttpResult(
        context,
        await this.executeRuntimeAction(
          actionId,
          input,
          connectionName,
          policy,
          runtimeGrant,
          tenantId,
          context.req.raw.signal,
        ),
      );
    }

    const now = new Date();
    const keyHash = hashIdempotencyKey(idempotencyKey.key);
    let requestHash: string;
    try {
      requestHash = hashActionRequest({
        tenantId,
        actionId,
        connectionName: connectionName ?? defaultConnectionName,
        input,
        runtimeTokenId: runtimeGrant?.tokenId,
      });
    } catch (error) {
      if (!(error instanceof ActionInputDepthError)) {
        throw error;
      }
      return writeRuntimeFailure(context, {
        status: 400,
        errorCode: "invalid_input",
        message: error.message,
        meta: { actionId },
      });
    }
    const claimId = crypto.randomUUID();
    const claim = await this.options.idempotency.claim({
      tenantId,
      keyHash,
      requestHash,
      claimId,
      now: now.toISOString(),
      expiresAt: createIdempotencyExpiry(now),
    });

    if (claim.kind === "conflict") {
      return writeRuntimeFailure(context, {
        status: 409,
        errorCode: "idempotency_key_conflict",
        message: "Idempotency-Key has already been used with a different request.",
        meta: { actionId },
      });
    }
    if (claim.kind === "in_progress") {
      return writeRuntimeFailure(context, {
        status: 409,
        errorCode: "idempotency_request_in_progress",
        message: "A request with this Idempotency-Key is still in progress.",
        meta: { actionId },
      });
    }
    if (claim.kind === "completed") {
      return writeRuntimeActionHttpResult(context, claim.response);
    }

    const result = await this.executeRuntimeAction(
      actionId,
      input,
      connectionName,
      policy,
      runtimeGrant,
      tenantId,
      context.req.raw.signal,
    );
    const completed = await this.options.idempotency.complete({
      tenantId,
      keyHash,
      requestHash,
      claimId,
      response: result,
      expiresAt: createIdempotencyExpiry(new Date()),
    });
    if (!completed) {
      throw new Error("Idempotency claim was replaced before completion.");
    }

    return writeRuntimeActionHttpResult(context, result);
  }

  private async executeRuntimeAction(
    actionId: string,
    input: unknown,
    connectionName: string | undefined,
    policy: ActionPolicySnapshot,
    runtimeGrant: RuntimeGrant | undefined,
    tenantId: TenantId,
    signal: AbortSignal | undefined,
  ): Promise<RuntimeActionHttpResult> {
    try {
      const run = await this.options.actions.run({
        tenantId,
        actionId,
        input,
        caller: "http",
        connectionName,
        policy,
        runtimeTokenId: runtimeGrant?.tokenId,
        signal,
      });
      if (!run) {
        return serializeRuntimeFailure(unknownActionFailure(actionId));
      }

      return serializeRuntimeActionResult({
        actionId,
        executionId: run.executionId,
        auditPersisted: run.auditPersisted,
        result: run.result,
      });
    } catch (error) {
      if (error instanceof ConnectionError) {
        return serializeRuntimeFailure({
          status: mapConnectionErrorStatus(error),
          errorCode: error.code,
          message: error.message,
          meta: { actionId },
        });
      }

      throw error;
    }
  }

  private async createRuntimeProxyRequest(context: Context, service: string): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(context);
    } catch (error) {
      if (error instanceof HttpRequestError) {
        return writeRuntimeFailure(context, {
          status: error.status,
          errorCode: error.code,
          message: error.message,
          meta: { service },
        });
      }

      throw error;
    }

    let policy: ActionPolicySnapshot;
    try {
      policy = await this.getPolicySnapshot(context);
    } catch {
      return writeRuntimeFailure(context, {
        status: 500,
        errorCode: "internal_error",
        message: "Runtime policy is unavailable.",
        meta: { service },
      });
    }
    const result = await this.proxyRunner.run({
      tenantId: this.tenantId(context),
      service,
      input: body,
      connectionName: readConnectionName(context, body),
      policy,
    });
    if (result.ok) {
      return writeRuntimeSuccess(context, result.response);
    }

    return writeRuntimeFailure(context, {
      status: result.status,
      errorCode: result.errorCode,
      message: result.message,
      data: result.data,
      meta: result.meta,
    });
  }

  private async listRuntimeApps(context: Context): Promise<Response> {
    let policy: ActionPolicySnapshot;
    try {
      policy = await this.getPolicySnapshot(context);
    } catch {
      return writeRuntimeFailure(context, {
        status: 500,
        errorCode: "internal_error",
        message: "Runtime policy is unavailable.",
      });
    }
    return writeRuntimeSuccess(
      context,
      this.filterAllowedConnections(policy, await this.options.connections.listConnections(this.tenantId(context))).map(
        serializeRuntimeConnectedApp,
      ),
    );
  }

  private async listRuntimeAppsByService(context: Context, service: string): Promise<Response> {
    let policy: ActionPolicySnapshot;
    try {
      policy = await this.getPolicySnapshot(context);
    } catch {
      return writeRuntimeFailure(context, {
        status: 500,
        errorCode: "internal_error",
        message: "Runtime policy is unavailable.",
        meta: { service },
      });
    }
    try {
      return writeRuntimeSuccess(
        context,
        this.filterAllowedConnections(
          policy,
          await this.options.connections.listConnectionsByService(service, this.tenantId(context)),
        ).map(serializeRuntimeConnectedApp),
      );
    } catch (error) {
      if (error instanceof ConnectionError) {
        return writeRuntimeFailure(context, {
          status: mapConnectionErrorStatus(error),
          errorCode: error.code,
          message: error.message,
          meta: { service },
        });
      }

      throw error;
    }
  }

  private async listAuthenticatedRuntimeApps(context: Context): Promise<Response> {
    const services = context.req.queries("service") ?? [];
    let policy: ActionPolicySnapshot;
    try {
      policy = await this.getPolicySnapshot(context);
    } catch {
      return writeRuntimeFailure(context, {
        status: 500,
        errorCode: "internal_error",
        message: "Runtime policy is unavailable.",
      });
    }
    const authenticated = new Set(
      this.filterAllowedConnections(policy, await this.options.connections.listConnections(this.tenantId(context)))
        .filter((connection) => connection.configured && connection.authType !== "no_auth")
        .map((connection) => connection.service),
    );
    return writeRuntimeSuccess(
      context,
      services.filter((service) => authenticated.has(service)),
    );
  }

  private filterAllowedConnections(
    policy: ActionPolicySnapshot,
    connections: ConnectionSummary[],
  ): ConnectionSummary[] {
    return connections.filter(
      (connection) => connection.authType === "no_auth" || policy.evaluateConnection(connection.id).allowed,
    );
  }

  private async handleMcp(context: Context): Promise<Response> {
    const handler = createMcpHandler(
      () =>
        createMcpServer({
          catalog: this.options.catalog,
          providerLoader: this.options.providerLoader,
          connections: this.options.connections,
          actions: this.options.actions,
          actionPolicy: this.actionPolicy,
          actionSearch: this.actionSearch,
          getPolicySnapshot: () => this.getPolicySnapshot(context),
          runtimeGrant: readRuntimeGrant(context),
          tenantId: this.tenantId(context),
          signal: context.req.raw.signal,
        }),
      { legacy: "stateless", responseMode: "json" },
    );
    try {
      return await handler.fetch(context.req.raw);
    } finally {
      await handler.close();
    }
  }

  private rejectMcpMethod(context: Context): Response {
    return context.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed.",
        },
        id: null,
      },
      405,
    );
  }

  private async listConnections(context: Context): Promise<Response> {
    return context.json(await this.options.connections.listConnections(this.tenantId(context)));
  }

  private async upsertConnection(context: Context, service: string): Promise<Response> {
    const body = await readJsonBody(context);
    const authType = optionalString(body.authType);
    if (!authType) {
      this.options.logger?.warn(
        {
          errorCode: "invalid_input",
          path: context.req.path,
          service,
        },
        "connection rejected",
      );
      return jsonError(context, 400, "invalid_input", "authType is required.");
    }

    const values = body.values ?? body;
    const connectionName = readConnectionName(context, body);
    const logContext: ConnectionLogContext = {
      operation: "connect",
      path: context.req.path,
      service,
      authType,
      connectionName,
    };
    if (authType === "no_auth") {
      this.options.logger?.info(logContext, "connection started");
      return this.writeConnectionResult(
        context,
        this.options.connections.connectWithoutAuth(service, { connectionName }, this.tenantId(context)),
        logContext,
      );
    }
    if (authType === "api_key") {
      this.options.logger?.info(logContext, "connection started");
      return this.writeConnectionResult(
        context,
        this.options.connections.connectWithApiKey(service, { values, connectionName }, this.tenantId(context)),
        logContext,
      );
    }
    if (authType === "custom_credential") {
      this.options.logger?.info(logContext, "connection started");
      return this.writeConnectionResult(
        context,
        this.options.connections.connectWithCustomCredential(
          service,
          { values, connectionName },
          this.tenantId(context),
        ),
        logContext,
      );
    }

    this.options.logger?.warn(
      {
        ...logContext,
        errorCode: "unsupported_auth_type",
      },
      "connection rejected",
    );
    return jsonError(context, 400, "unsupported_auth_type", `${service} does not support ${authType}.`);
  }

  private async disconnect(context: Context, service: string): Promise<Response> {
    const body = context.req.header("content-type")?.includes("application/json") ? await readJsonBody(context) : {};
    const connectionName = readConnectionName(context, body);
    const logContext: ConnectionLogContext = {
      operation: "disconnect",
      path: context.req.path,
      service,
      connectionName,
    };
    this.options.logger?.info(logContext, "connection disconnect started");
    return this.writeConnectionResult(
      context,
      this.options.connections.disconnect(service, connectionName, this.tenantId(context)),
      logContext,
    );
  }

  private async createOAuthAuthorization(context: Context): Promise<Response> {
    const body = await readJsonBody(context);
    const requestedService = optionalString(body.service);
    const connectionName = readConnectionName(context, body);
    let returnUrl: string | undefined;
    try {
      const requestedReturnUrl = optionalString(body.returnUrl);
      if (requestedReturnUrl) {
        let parsed: URL;
        try {
          parsed = new URL(requestedReturnUrl);
        } catch {
          throw new OAuthFlowError("invalid_input", "returnUrl must be an absolute HTTPS URL.");
        }
        const localhost = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
        if ((parsed.protocol !== "https:" && !localhost) || parsed.username || parsed.password || parsed.hash) {
          throw new OAuthFlowError(
            "invalid_input",
            "returnUrl must be an absolute HTTPS URL without credentials or fragments.",
          );
        }
        if (!(this.options.allowedOAuthReturnUrlOrigins ?? []).includes(parsed.origin)) {
          throw new OAuthFlowError("invalid_input", "returnUrl is not an allowed OAuth completion origin.");
        }
        returnUrl = parsed.toString();
      }

      const service = requiredString(
        body.service,
        "service",
        (message) => new OAuthFlowError("invalid_input", message),
      );
      const sessionCorrelation = optionalString(body.sessionCorrelation);
      if (this.options.auth?.sharedRuntime && !sessionCorrelation) {
        throw new OAuthFlowError("invalid_input", "sessionCorrelation is required in shared mode.");
      }
      if (this.options.auth?.sharedRuntime && !returnUrl) {
        throw new OAuthFlowError("invalid_input", "returnUrl is required in shared mode.");
      }
      const logContext = { path: context.req.path, service, connectionName };
      this.options.logger?.info(logContext, "oauth authorization started");

      const authorization = await this.options.oauthFlow.startAuthorization({
        tenantId: this.tenantId(context),
        service,
        connectionName,
        sessionCorrelation: sessionCorrelation ?? crypto.randomUUID(),
        returnUrl,
        clientConfig: readOAuthClientConfigInput(body),
        requestedScopes: readRequestedScopes(body),
      });
      const authorizationUrl = new URL(authorization.authorizationUrl);
      this.options.logger?.info(
        {
          ...logContext,
          authorizationHost: authorizationUrl.host,
          redirectUri: authorizationUrl.searchParams.get("redirect_uri") ?? undefined,
        },
        "oauth authorization created",
      );
      return context.json(authorization);
    } catch (error) {
      if (
        error instanceof OAuthClientConfigError ||
        error instanceof OAuthFlowError ||
        error instanceof ConnectionError
      ) {
        this.options.logger?.warn(
          { errorCode: error.code, path: context.req.path, service: requestedService, connectionName },
          "oauth authorization failed",
        );
        return jsonError(context, error.code === "unknown_service" ? 404 : 400, error.code, error.message);
      }
      throw error;
    }
  }

  private async listRuntimeTokens(context: Context): Promise<Response> {
    return context.json(await this.options.runtimeTokens.listTokens(this.tenantId(context)));
  }

  private async createRuntimeToken(context: Context): Promise<Response> {
    const body = await readJsonBody(context, policyRequestMaxBytes);
    const name = optionalString(body.name);
    if (!name) {
      return jsonError(context, 400, "invalid_input", "name is required.");
    }

    const created = await this.options.runtimeTokens.createToken(
      name,
      readTokenPolicy(body, true),
      this.tenantId(context),
    );
    return context.json({
      token: created.token,
      record: summarizeRuntimeToken(created.record),
    });
  }

  private async updateRuntimeToken(context: Context, id: string): Promise<Response> {
    const body = await readJsonBody(context, policyRequestMaxBytes);
    const token = await this.options.runtimeTokens.updateTokenPolicy(id, readTokenPolicy(body), this.tenantId(context));
    return token
      ? context.json(token)
      : jsonError(context, 404, "runtime_token_not_found", `Runtime token not found: ${id}.`);
  }

  private async revokeRuntimeToken(context: Context, id: string): Promise<Response> {
    if (!(await this.options.runtimeTokens.revokeToken(id, this.tenantId(context)))) {
      return jsonError(context, 404, "runtime_token_not_found", `Runtime token not found: ${id}.`);
    }

    return context.json({ id, revoked: true });
  }

  private async getRuntimePolicy(context: Context): Promise<Response> {
    return context.json((await this.getPolicySnapshot(context)).state);
  }

  private async updateRuntimePolicy(context: Context): Promise<Response> {
    const body = await readJsonBody(context, policyRequestMaxBytes);
    const rules = readRuntimePolicyRules(body);
    const updatedAt = new Date().toISOString();
    await this.options.runtimePolicyStore.set({ rules, updatedAt });
    return context.json({
      deployment: this.actionPolicy.rules,
      runtime: rules,
      updatedAt,
    });
  }

  private async listOAuthConfigs(context: Context): Promise<Response> {
    return context.json(await this.options.oauthClientConfigs.listConfigs());
  }

  private async upsertOAuthConfig(context: Context, service: string): Promise<Response> {
    const body = await readJsonBody(context);
    return this.writeOAuthResult(
      context,
      this.options.oauthClientConfigs.upsertConfig({
        service,
        clientId: optionalString(body.clientId) ?? "",
        clientSecret: optionalString(body.clientSecret) ?? "",
        requestedScopes: readRequestedScopes(body),
        extra: optionalRecord(body.extra),
        secretExtra: optionalRecord(body.secretExtra),
      }),
    );
  }

  private async deleteOAuthConfig(context: Context, service: string): Promise<Response> {
    return this.writeOAuthResult(context, this.options.oauthClientConfigs.deleteConfig(service));
  }

  private async completeOAuth(context: Context): Promise<Response> {
    const state = context.req.query("state");
    const code = context.req.query("code");
    const providerError = context.req.query("error");
    const logContext = { path: context.req.path, hasState: Boolean(state), hasCode: Boolean(code) };
    this.options.logger?.info(logContext, "oauth callback received");
    if (!state) {
      return jsonError(context, 400, "invalid_oauth_callback", "OAuth callback requires state and code.");
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(state)) {
      return jsonError(context, 400, "invalid_oauth_state", "OAuth state is invalid.");
    }
    if (providerError || !code) {
      try {
        const pending = await this.options.oauthFlow.consumeAuthorizationState(state);
        if (!pending.returnUrl) {
          return jsonError(
            context,
            400,
            providerError ? "oauth_provider_error" : "invalid_oauth_callback",
            providerError
              ? `OAuth provider returned error "${providerError}"${context.req.query("error_description") ? `: ${context.req.query("error_description")}` : "."}`
              : "OAuth callback requires state and code.",
          );
        }
        return context.html(
          renderOAuthCompletionPage(pending.service, {
            ok: false,
            message: providerError
              ? "Provider authorization was cancelled or denied."
              : "OAuth callback did not include an authorization code.",
            returnUrl: pending.returnUrl,
          }),
        );
      } catch (error) {
        if (error instanceof OAuthFlowError) {
          if (providerError) {
            return jsonError(
              context,
              400,
              "oauth_provider_error",
              `OAuth provider returned error "${providerError}"${context.req.query("error_description") ? `: ${context.req.query("error_description")}` : "."}`,
            );
          }
          return jsonError(context, 400, error.code, error.message);
        }
        throw error;
      }
    }

    try {
      if (this.options.auth?.sharedRuntime) {
        const staged = await this.options.oauthFlow.stageAuthorization(state, code);
        const returnUrl = staged.returnUrl
          ? appendOAuthCompletion(staged.returnUrl, staged.completionCapability)
          : undefined;
        this.options.logger?.info({ ...logContext, service: staged.service }, "oauth callback staged");
        return context.html(renderOAuthCompletionPage(staged.service, { ok: true, returnUrl }));
      }
      const result = await this.options.oauthFlow.completeLocalAuthorization(state, code);
      this.options.logger?.info({ ...logContext, service: result.service }, "oauth callback completed");
      return context.html(renderOAuthCompletionPage(result.service, { ok: true, returnUrl: result.returnUrl }));
    } catch (error) {
      if (error instanceof OAuthFlowError || error instanceof ConnectionError) {
        this.options.logger?.warn({ ...logContext, errorCode: error.code }, "oauth callback failed");
        if (error instanceof OAuthFlowError && error.returnUrl) {
          return context.html(
            renderOAuthCompletionPage("OAuth", {
              ok: false,
              message: "OAuth could not be completed. Return to the application and try again.",
              returnUrl: error.returnUrl,
            }),
          );
        }
        return jsonError(context, error.code === "unknown_service" ? 404 : 400, error.code, error.message);
      }
      throw error;
    }
  }

  private async completeTenantOAuth(context: Context): Promise<Response> {
    const body = await readJsonBody(context);
    try {
      const result = await this.options.oauthFlow.completeAuthorization({
        completionCapability: requiredString(
          body.completionCapability,
          "completionCapability",
          (message) => new OAuthFlowError("invalid_input", message),
        ),
        sessionCorrelation: requiredString(
          body.sessionCorrelation,
          "sessionCorrelation",
          (message) => new OAuthFlowError("invalid_input", message),
        ),
        tenantId: this.tenantId(context),
      });
      return context.json(result);
    } catch (error) {
      if (error instanceof OAuthFlowError || error instanceof ConnectionError) {
        return jsonError(context, error.code === "unknown_service" ? 404 : 400, error.code, error.message);
      }
      throw error;
    }
  }

  private async writeConnectionResult(
    context: Context,
    operation: Promise<unknown>,
    logContext?: ConnectionLogContext,
  ): Promise<Response> {
    try {
      const result = await operation;
      if (logContext) {
        this.options.logger?.info(
          logContext,
          logContext.operation === "disconnect" ? "connection disconnect completed" : "connection completed",
        );
      }
      return context.json(result);
    } catch (error) {
      if (error instanceof ConnectionError) {
        if (logContext) {
          this.options.logger?.warn(
            {
              ...logContext,
              errorCode: error.code,
            },
            logContext.operation === "disconnect" ? "connection disconnect failed" : "connection failed",
          );
        }
        return jsonError(context, error.code === "unknown_service" ? 404 : 400, error.code, error.message);
      }

      throw error;
    }
  }

  private async writeOAuthResult(context: Context, operation: Promise<unknown>): Promise<Response> {
    try {
      return context.json(await operation);
    } catch (error) {
      if (error instanceof OAuthClientConfigError || error instanceof OAuthFlowError) {
        return jsonError(context, error.code === "unknown_service" ? 404 : 400, error.code, error.message);
      }
      if (error instanceof HttpRequestError) {
        return jsonError(context, 400, error.code, error.message);
      }

      throw error;
    }
  }

  private getTenantContext(context: Context): Response {
    const principal = readAuthenticatedPrincipal(context);
    if (principal?.kind !== "tenant" || principal.capability !== "tenant-admin") {
      return context.json({ error: { code: "forbidden", message: "A tenant-admin credential is required." } }, 403);
    }
    return context.json({ tenantId: principal.tenantId, capability: principal.capability });
  }

  private async getRuntimePrincipal(context: Context): Promise<Response> {
    if (hasTenantSelector(context) || (await hasRequestBody(context))) {
      return jsonError(context, 400, "invalid_input", "This endpoint does not accept tenant selectors or a body.");
    }
    const principal = readAuthenticatedPrincipal(context);
    if (principal?.kind !== "tenant" || principal.capability !== "runtime") {
      return jsonError(context, 401, "unauthorized", "A runtime bearer token is required.");
    }
    const isNonSharedCompatibilityPrincipal =
      !this.options.auth?.sharedRuntime &&
      (principal.runtimeTokenId === "bootstrap" || principal.runtimeTokenId === "local-open");
    if (!readRuntimeGrant(context) && !isNonSharedCompatibilityPrincipal) {
      return jsonError(context, 401, "unauthorized", "A persistent tenant runtime credential is required.");
    }
    return context.json(serializeRuntimePrincipal(principal));
  }

  private async listTenants(context: Context): Promise<Response> {
    return context.json(await this.requireTenantCredentials().listTenants());
  }

  private async createTenant(context: Context): Promise<Response> {
    const body = await readJsonBody(context);
    const id = parseTenantId(
      requiredString(body.id, "id", (message) => new HttpRequestError("invalid_input", message)),
    );
    const displayName = requiredString(
      body.displayName,
      "displayName",
      (message) => new HttpRequestError("invalid_input", message),
    );
    const record = { id, displayName, createdAt: new Date().toISOString() };
    await this.requireTenantCredentials().createTenant(record);
    return context.json(record, 201);
  }

  private async createTenantAdminCredential(context: Context, tenantIdInput: string): Promise<Response> {
    const body = await readJsonBody(context);
    const name = requiredString(body.name, "name", (message) => new HttpRequestError("invalid_input", message));
    const created = await this.requireTenantCredentials().issueAdminCredential(parseTenantId(tenantIdInput), name);
    return context.json({
      credential: created.credential,
      record: {
        id: created.record.id,
        tenantId: created.record.tenantId,
        name: created.record.name,
        createdAt: created.record.createdAt,
      },
    });
  }

  private async listTenantAdminCredentials(context: Context, tenantIdInput: string): Promise<Response> {
    const records = await this.requireTenantCredentials().listAdminCredentials(parseTenantId(tenantIdInput));
    return context.json(records.map(({ tokenHash: _tokenHash, ...record }) => record));
  }

  private async revokeTenantAdminCredential(
    context: Context,
    tenantIdInput: string,
    credentialId: string,
  ): Promise<Response> {
    const tenantId = parseTenantId(tenantIdInput);
    if (!(await this.requireTenantCredentials().revokeAdminCredential(tenantId, credentialId))) {
      return jsonError(context, 404, "tenant_admin_credential_not_found", "Tenant admin credential was not found.");
    }
    return context.json({ id: credentialId, tenantId, revoked: true });
  }

  private tenantId(context: Context): TenantId {
    const principal = readAuthenticatedPrincipal(context);
    if (principal?.kind === "tenant") return principal.tenantId;
    if (this.options.auth?.sharedRuntime) {
      throw new HttpRequestError("tenant_principal_required", "A tenant principal is required.", 401);
    }
    return compatibilityTenantId;
  }

  private requireTenantCredentials(): TenantCredentialService {
    if (!this.options.tenantCredentials) throw new Error("Tenant credential storage is unavailable.");
    return this.options.tenantCredentials;
  }

  private getPolicySnapshot(context: Context): Promise<ActionPolicySnapshot> {
    const request = context.req.raw;
    let snapshot = this.policySnapshots.get(request);
    if (!snapshot) {
      snapshot = this.loadPolicySnapshot(context);
      this.policySnapshots.set(request, snapshot);
    }
    return snapshot;
  }

  private async loadPolicySnapshot(context: Context): Promise<ActionPolicySnapshot> {
    try {
      const record = await this.options.runtimePolicyStore.get();
      return this.actionPolicy.createSnapshot(
        record?.rules ?? emptyPolicyRules(),
        readRuntimeGrant(context),
        record?.updatedAt,
      );
    } catch {
      this.options.logger?.error(
        {
          method: context.req.method,
          path: context.req.path,
        },
        "runtime policy load failed",
      );
      throw new Error("Runtime policy is unavailable.");
    }
  }
}

function appendOAuthCompletion(returnUrl: string, completionCapability: string): string {
  const url = new URL(returnUrl);
  url.searchParams.set("oauthCompletion", completionCapability);
  return url.toString();
}

function hasTenantSelector(context: Context): boolean {
  const isTenantSelector = (name: string): boolean =>
    ["tenantid", "xtenantid", "xootenantid", "xoomoltenantid"].includes(
      name.toLowerCase().replaceAll("-", "").replaceAll("_", ""),
    );
  return (
    [...new URL(context.req.url).searchParams.keys()].some(isTenantSelector) ||
    [...context.req.raw.headers.keys()].some(isTenantSelector)
  );
}

async function hasRequestBody(context: Context): Promise<boolean> {
  const contentLength = context.req.header("content-length")?.trim();
  if ((contentLength !== undefined && contentLength !== "0") || context.req.header("transfer-encoding") !== undefined) {
    return true;
  }
  return context.req.raw.body !== null && (await context.req.raw.clone().arrayBuffer()).byteLength > 0;
}

function readOAuthClientConfigInput(body: Record<string, unknown>): OAuthClientConfigInput | undefined {
  const keys = ["clientId", "clientSecret", "extra", "secretExtra"];
  if (!keys.some((key) => key in body)) {
    return undefined;
  }

  return {
    clientId: optionalString(body.clientId) ?? "",
    clientSecret: optionalString(body.clientSecret) ?? "",
    requestedScopes: readRequestedScopes(body),
    extra: optionalRecord(body.extra),
    secretExtra: optionalRecord(body.secretExtra),
  };
}

function readRequestedScopes(body: Record<string, unknown>): string[] | undefined {
  if (!("requestedScopes" in body)) {
    return undefined;
  }
  return requiredStringArray(
    body.requestedScopes,
    "requestedScopes",
    (message) => new HttpRequestError("invalid_input", `${message}.`),
  );
}

interface ConnectionLogContext {
  operation: "connect" | "disconnect";
  path: string;
  service: string;
  authType?: string;
  connectionName?: string;
}

/**
 * RFC 7232 `If-None-Match` check. Handles `*`, comma-separated lists, and the
 * weak-comparison prefix (`W/`) so a validator round-tripped through gzip (which
 * downgrades strong to weak) still matches.
 */
function requestMatchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) {
    return false;
  }
  if (ifNoneMatch.trim() === "*") {
    return true;
  }
  const target = stripWeakPrefix(etag);
  return ifNoneMatch.split(",").some((candidate) => stripWeakPrefix(candidate.trim()) === target);
}

function stripWeakPrefix(etag: string): string {
  return etag.startsWith("W/") ? etag.slice(2) : etag;
}

function readConnectionName(context: Context, body?: Record<string, unknown>): string | undefined {
  return (
    optionalString(body?.connectionName) ??
    optionalString(body?.alias) ??
    optionalString(context.req.header("x-oomol-connector-alias")) ??
    optionalString(context.req.header("x-oo-connector-alias")) ??
    optionalString(context.req.query("connectionName")) ??
    optionalString(context.req.query("alias"))
  );
}

type SearchQuery =
  | {
      ok: true;
      q: string;
      service?: string;
      limit: number;
    }
  | {
      ok: false;
      message: string;
    };

type RunLogListQuery =
  | {
      ok: true;
      input: RunLogListInput;
    }
  | {
      ok: false;
      message: string;
    };

interface RuntimeActionSearchResult {
  id: string;
  service: string;
  name: string;
  description: string;
  authenticated: boolean;
  inputSchema: RuntimeActionDefinition["inputSchema"];
  outputSchema: RuntimeActionDefinition["outputSchema"];
}

function serializeActionSearchResult(
  result: ActionSearchResult,
  action: RuntimeActionDefinition,
  authenticated: boolean,
): RuntimeActionSearchResult {
  return {
    id: result.id,
    service: result.service,
    name: result.name,
    description: result.description,
    authenticated,
    inputSchema: action.inputSchema,
    outputSchema: action.outputSchema,
  };
}

function readRunLogListInput(context: Context): RunLogListQuery {
  const rawLimit = optionalString(context.req.query("limit"));
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { ok: false, message: "limit must be an integer between 1 and 100." };
  }

  const cursor = optionalString(context.req.query("cursor"));
  if (cursor !== undefined) {
    try {
      decodeRunLogCursor(cursor);
    } catch {
      return { ok: false, message: "cursor is invalid." };
    }
  }

  const input: RunLogListInput = { limit };
  if (cursor !== undefined) {
    input.cursor = cursor;
  }
  const service = optionalString(context.req.query("service"));
  if (service !== undefined) {
    input.service = service;
  }
  const actionId = optionalString(context.req.query("actionId"));
  if (actionId !== undefined) {
    if (actionId.length > 256) {
      return { ok: false, message: "actionId must be at most 256 characters." };
    }
    input.actionId = actionId;
  }
  const caller = optionalString(context.req.query("caller"));
  if (caller !== undefined) {
    if (!isRunLogCaller(caller)) {
      return { ok: false, message: "caller must be one of http, mcp, or web." };
    }
    input.caller = caller;
  }
  const ok = optionalString(context.req.query("ok"));
  if (ok !== undefined) {
    if (ok !== "true" && ok !== "false") {
      return { ok: false, message: "ok must be true or false." };
    }
    input.ok = ok === "true";
  }

  return { ok: true, input };
}

function isRunLogCaller(value: string): value is RunLogCaller {
  return value === "http" || value === "mcp" || value === "web";
}

function readSearchQuery(context: Context, defaultLimit = DEFAULT_ACTION_SEARCH_LIMIT): SearchQuery {
  const q = optionalString(context.req.query("q") ?? context.req.query("query"));
  if (!q || q.length > 256) {
    return { ok: false, message: "q must be a non-empty string of at most 256 characters." };
  }

  const rawLimit = optionalString(context.req.query("limit"));
  if (!rawLimit) {
    return {
      ok: true,
      q,
      service: optionalString(context.req.query("service")),
      limit: defaultLimit,
    };
  }

  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return { ok: false, message: "limit must be an integer between 1 and 50." };
  }

  return {
    ok: true,
    q,
    service: optionalString(context.req.query("service")),
    limit,
  };
}
