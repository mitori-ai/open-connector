import type {
  AppData,
  ConnectionRecord,
  OAuthConfig,
  OperatorTenant,
  ProviderDefinition,
  RunLogPage,
  RuntimePolicyState,
  RuntimeTokenSummary,
} from "./model";
import type { ReactNode, SubmitEvent } from "react";

import { useTranslate } from "@embra/i18n/react";
import {
  Activity,
  ArrowLeft,
  BookOpen,
  Building2,
  Cable,
  Fingerprint,
  Home,
  KeyRound,
  Loader2,
  LogOut,
  RefreshCw,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router";
import { AccessPage } from "./access-page";
import { ActionsPage } from "./actions-page";
import { ApiError, apiDelete, apiGet, apiPost } from "./api";
import mitoriMarkUrl from "./assets/mitori-mark.png";
import { ConsoleApiProvider, consoleApiRoutes } from "./console-api";
import { emptyData } from "./model";
import { OAuthAppsPage } from "./oauth-apps-page";
import {
  oauthCompletedType,
  oauthCompletionChannelName,
  oauthConsoleCompletionPath,
  oauthConsoleStorageKey,
} from "./oauth-console-flow";
import { OperatorPage } from "./operator-page";
import { OverviewPage } from "./overview-page";
import { ProvidersPage } from "./providers-page";
import { ResourcesPage } from "./resources-page";
import { RunsPage } from "./runs-page";
import { InlineError, StatusDot } from "./shared-ui";
import { useThemeMode } from "./theme";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const navItems = [
  { path: "/overview", labelKey: "nav.overview", icon: Home },
  { path: "/providers", labelKey: "nav.providers", icon: Cable },
  { path: "/oauth-apps", labelKey: "nav.oauthApps", icon: Fingerprint },
  { path: "/actions", labelKey: "nav.actions", icon: TerminalSquare },
  { path: "/runs", labelKey: "nav.runs", icon: Activity },
  { path: "/access", labelKey: "nav.access", icon: KeyRound },
  { path: "/resources", labelKey: "nav.docs", icon: BookOpen },
] as const;

const operatorNavItems = [
  { path: "/overview", labelKey: "operator.title", icon: Building2 },
  { path: "/oauth-apps", labelKey: "nav.oauthApps", icon: Fingerprint },
  { path: "/resources", labelKey: "nav.docs", icon: BookOpen },
] as const;

const tenantNavItems = navItems.filter((item) => item.path !== "/oauth-apps");

export interface AuthSession {
  adminAuthConfigured: boolean;
  authenticated: boolean;
  sharedRuntime?: boolean;
  tenantId?: string;
}

export interface OAuthCompletionMessage {
  type: typeof oauthCompletedType;
  service: string;
}

export function subscribeToOAuthCompletions(onComplete: (message: OAuthCompletionMessage) => void): () => void {
  const handleMessage = (event: MessageEvent<unknown>): void => {
    if (isOAuthCompletionMessage(event.data)) {
      onComplete(event.data);
    }
  };

  if (typeof BroadcastChannel === "undefined") {
    return () => {};
  }

  const channel = new BroadcastChannel(oauthCompletionChannelName);
  channel.addEventListener("message", handleMessage);
  return () => channel.close();
}

function isOAuthCompletionMessage(value: unknown): value is OAuthCompletionMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const message = value as { type?: unknown; service?: unknown };
  return message.type === oauthCompletedType && typeof message.service === "string";
}

export interface LogoutState {
  authSession: AuthSession;
}

export function nextLogoutState(state: LogoutState, succeeded: boolean): LogoutState {
  return succeeded
    ? {
        authSession: { ...state.authSession, authenticated: false },
      }
    : state;
}

export interface AuthLoadState {
  pendingUnlockToken: string;
  authSession: AuthSession;
  locked: boolean;
}

export function nextAuthLoadState(state: AuthLoadState, session: AuthSession): AuthLoadState {
  return {
    pendingUnlockToken: session.authenticated ? "" : state.pendingUnlockToken,
    authSession: session,
    locked: !session.authenticated,
  };
}

export interface RuntimeLoadResult {
  authSession: AuthSession;
  data: AppData;
  operatorTenants: OperatorTenant[];
}

/**
 * Loads dashboard state.
 *
 * The provider catalog is generated at build time and cannot change while the
 * server runs, so `cachedProviders` lets refreshes skip re-downloading it and
 * re-fetch only mutable data.
 */
export async function loadRuntimeData(
  unlockToken: string,
  cachedProviders?: ProviderDefinition[],
): Promise<RuntimeLoadResult> {
  const authSession = await apiGet<AuthSession>("/api/auth/session", { bearerToken: unlockToken });
  if (!authSession.authenticated) {
    return { authSession, data: emptyData, operatorTenants: [] };
  }

  if (authSession.sharedRuntime) {
    const tenantScoped = Boolean(authSession.tenantId);
    const apiRoutes = consoleApiRoutes(tenantScoped);
    const catalogRequest =
      cachedProviders !== undefined
        ? Promise.resolve(cachedProviders)
        : apiGet<ProviderDefinition[]>(apiRoutes.providers);
    if (!tenantScoped) {
      const [operatorTenants, providers, oauthConfigs] = await Promise.all([
        apiGet<OperatorTenant[]>("/api/operator/tenants"),
        catalogRequest,
        apiGet<OAuthConfig[]>("/api/oauth/configs"),
      ]);
      return {
        authSession,
        data: { ...emptyData, providers, oauthConfigs },
        operatorTenants,
      };
    }

    const [operatorTenants, providers, connections, oauthConfigs, runtimeTokens, runtimePolicy, runPage] =
      await Promise.all([
        apiGet<OperatorTenant[]>("/api/operator/tenants"),
        catalogRequest,
        apiGet<ConnectionRecord[]>(apiRoutes.connections),
        apiGet<OAuthConfig[]>("/api/oauth/configs"),
        apiGet<RuntimeTokenSummary[]>(apiRoutes.runtimeTokens),
        apiGet<RuntimePolicyState>("/api/runtime-policy"),
        apiGet<RunLogPage>(apiRoutes.runs),
      ]);
    return {
      authSession,
      data: {
        providers,
        connections,
        oauthConfigs,
        runtimeTokens,
        runtimePolicy,
        runs: runPage.items,
        runsNextCursor: runPage.nextCursor,
      },
      operatorTenants,
    };
  }

  const catalogRequest =
    cachedProviders !== undefined ? Promise.resolve(cachedProviders) : apiGet<ProviderDefinition[]>("/api/providers");

  const [providers, connections, oauthConfigs, runtimeTokens, runtimePolicy, runPage] = await Promise.all([
    catalogRequest,
    apiGet<ConnectionRecord[]>("/api/connections"),
    apiGet<OAuthConfig[]>("/api/oauth/configs"),
    apiGet<RuntimeTokenSummary[]>("/api/runtime-tokens"),
    apiGet<RuntimePolicyState>("/api/runtime-policy"),
    apiGet<RunLogPage>("/api/runs"),
  ]);

  return {
    authSession,
    data: {
      providers,
      connections,
      oauthConfigs,
      runtimeTokens,
      runtimePolicy,
      runs: runPage.items,
      runsNextCursor: runPage.nextCursor,
    },
    operatorTenants: [],
  };
}

export function App(): ReactNode {
  useThemeMode();
  const location = useLocation();
  return location.pathname === oauthConsoleCompletionPath ? <TenantOAuthCompletionView /> : <ConsoleApp />;
}

function ConsoleApp(): ReactNode {
  const t = useTranslate();
  const [data, setData] = useState<AppData>(emptyData);
  const [operatorTenants, setOperatorTenants] = useState<OperatorTenant[]>([]);
  const [authSession, setAuthSession] = useState<AuthSession>({
    adminAuthConfigured: false,
    authenticated: true,
    sharedRuntime: false,
  });
  const pendingUnlockToken = useRef("");
  // Catalog is immutable while the server runs, so it is fetched once and
  // reused across refreshes instead of being re-downloaded on every action.
  const cachedProviders = useRef<ProviderDefinition[] | undefined>(undefined);
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [runtimeChecked, setRuntimeChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(
    () =>
      subscribeToOAuthCompletions(() => {
        setRefreshToken((value) => value + 1);
      }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const requestUnlockToken = pendingUnlockToken.current;
    setLoading(true);
    loadRuntimeData(requestUnlockToken, cachedProviders.current)
      .then(({ authSession: session, data: nextData, operatorTenants: nextOperatorTenants }) => {
        if (!cancelled) {
          cachedProviders.current = session.authenticated ? nextData.providers : undefined;
          const nextAuth = nextAuthLoadState(
            {
              pendingUnlockToken: pendingUnlockToken.current,
              authSession,
              locked,
            },
            session,
          );
          pendingUnlockToken.current = nextAuth.pendingUnlockToken;
          setData(nextData);
          setOperatorTenants(nextOperatorTenants);
          setAuthSession(nextAuth.authSession);
          setLocked(nextAuth.locked);
          setError(session.authenticated ? null : requestUnlockToken.trim() ? t("shell.invalidUnlockToken") : null);
        }
      })
      .catch((caught: unknown) => {
        if (cancelled) {
          return;
        }
        if (caught instanceof ApiError && caught.status === 401) {
          pendingUnlockToken.current = "";
          cachedProviders.current = undefined;
          setData(emptyData);
          setAuthSession({ adminAuthConfigured: true, authenticated: false, sharedRuntime: false });
          setLocked(true);
          setError(requestUnlockToken.trim() ? t("shell.invalidUnlockToken") : null);
          return;
        }
        setError(caught instanceof Error ? caught.message : t("shell.loadRuntimeFailed"));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setRuntimeChecked(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [refreshToken, t]);

  function refresh(): void {
    setRefreshToken((value) => value + 1);
  }

  function unlock(token: string): void {
    pendingUnlockToken.current = token;
    setLoading(true);
    refresh();
  }

  function logout(): void {
    void apiPost("/api/auth/logout", {})
      .then(() => {
        const next = nextLogoutState({ authSession }, true);
        setAuthSession(next.authSession);
        setError(null);
        refresh();
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : t("shell.logoutFailed"));
      });
  }

  function selectTenant(tenantId: string): void {
    setLoading(true);
    setError(null);
    void apiPost(`/api/operator/tenants/${encodeURIComponent(tenantId)}/session`, {})
      .then(() => refresh())
      .catch((caught: unknown) => {
        setLoading(false);
        setError(caught instanceof Error ? caught.message : t("operator.sessionFailed"));
      });
  }

  function exitTenant(): void {
    setLoading(true);
    setError(null);
    void apiDelete("/api/operator/tenant-session")
      .then(() => refresh())
      .catch((caught: unknown) => {
        setLoading(false);
        setError(caught instanceof Error ? caught.message : t("operator.exitFailed"));
      });
  }

  if (locked) {
    return <UnlockView loading={loading} message={error} onUnlock={unlock} />;
  }

  if (!runtimeChecked) {
    return <InitialLoadingView />;
  }

  const activeTenant = authSession.tenantId
    ? operatorTenants.find((tenant) => tenant.id === authSession.tenantId)
    : undefined;

  return (
    <AppShell
      data={data}
      operatorTenants={authSession.sharedRuntime ? operatorTenants : undefined}
      activeTenant={activeTenant}
      loading={loading}
      error={error}
      onRefresh={refresh}
      onLogout={logout}
      onSelectTenant={selectTenant}
      onExitTenant={exitTenant}
    />
  );
}

type OAuthCompletionStatus = "completing" | "complete" | "error";

function TenantOAuthCompletionView(): ReactNode {
  const t = useTranslate();
  const location = useLocation();
  const [status, setStatus] = useState<OAuthCompletionStatus>("completing");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const query = new URLSearchParams(location.search);
    const flowId = query.get("flow") ?? "";
    const service = query.get("service") ?? "";
    const completionCapability = query.get("oauthCompletion") ?? "";
    const providerError = query.get("oauthError");

    if (providerError) {
      setStatus("error");
      setMessage(providerError);
      return () => {};
    }

    const storageKey = oauthConsoleStorageKey(flowId);
    const sessionCorrelation = flowId ? window.sessionStorage.getItem(storageKey) : null;
    if (!flowId || !service || !completionCapability || !sessionCorrelation) {
      setStatus("error");
      setMessage(t("oauthConsole.invalid"));
      return () => {};
    }

    void apiPost("/api/tenant/oauth/completions", { completionCapability, sessionCorrelation })
      .then(() => {
        if (cancelled) {
          return;
        }
        window.sessionStorage.removeItem(storageKey);
        if (typeof BroadcastChannel !== "undefined") {
          const channel = new BroadcastChannel(oauthCompletionChannelName);
          channel.postMessage({ type: oauthCompletedType, service } satisfies OAuthCompletionMessage);
          channel.close();
        }
        setStatus("complete");
        closeTimer = setTimeout(() => window.close(), 750);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setStatus("error");
          setMessage(caught instanceof Error ? caught.message : t("oauthConsole.failed"));
        }
      });

    return () => {
      cancelled = true;
      if (closeTimer) {
        clearTimeout(closeTimer);
      }
    };
  }, [location.search, t]);

  return (
    <main className="unlock-screen">
      <section className="unlock-panel">
        <div className="brand">
          <img className="brand-mark" src={mitoriMarkUrl} alt="" />
          <div>
            <div className="brand-name">Mitori</div>
            <div className="brand-subtitle">{t("brand.adminAccess")}</div>
          </div>
        </div>
        {status === "completing" ? (
          <div className="loading-panel">
            <Loader2 className="spin" size={16} />
            {t("oauthConsole.completing")}
          </div>
        ) : status === "complete" ? (
          <div className="loading-panel">{t("oauthConsole.complete")}</div>
        ) : (
          <InlineError message={message ?? t("oauthConsole.failed")} />
        )}
      </section>
    </main>
  );
}

function InitialLoadingView(): ReactNode {
  const t = useTranslate();

  return (
    <main className="unlock-screen">
      <div className="loading-panel">
        <Loader2 className="spin" size={16} />
        {t("common.loadingRuntimeData")}
      </div>
    </main>
  );
}

function AppShell(props: {
  data: AppData;
  operatorTenants?: OperatorTenant[];
  activeTenant?: OperatorTenant;
  loading: boolean;
  error: string | null;
  onRefresh(): void;
  onLogout(): void;
  onSelectTenant(tenantId: string): void;
  onExitTenant(): void;
}): ReactNode {
  const t = useTranslate();
  const location = useLocation();
  const heading = headingForPath(location.pathname);
  const section = location.pathname.split("/").filter(Boolean)[0];
  const isOverviewPage = heading === "overview";
  const isBrowserPage = section === "actions" || section === "runs";
  const isRunsPage = section === "runs";
  const sharedRuntime = props.operatorTenants !== undefined;
  const tenantMode = sharedRuntime && props.activeTenant !== undefined;
  const operatorMode = sharedRuntime && !tenantMode;
  const visibleNavItems = operatorMode ? operatorNavItems : tenantMode ? tenantNavItems : navItems;
  const mainClassName = [
    isBrowserPage ? "main main-browser" : "main",
    isOverviewPage ? "overview-main" : "",
    isRunsPage ? "runs-main" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={sharedRuntime ? "app-shell shared-runtime-shell" : "app-shell"}>
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src={mitoriMarkUrl} alt="" />
          <div>
            <div className="brand-name">Mitori</div>
            {sharedRuntime ? (
              <div className="brand-subtitle">
                {operatorMode ? t("operator.workspaceTitle") : props.activeTenant?.displayName}
              </div>
            ) : null}
          </div>
        </div>

        <nav className="sidebar-nav" aria-label={t("shell.primaryNav")}>
          <div className="nav-group">
            <div className="nav-group-label">
              <span className="nav-group-dot" aria-hidden="true" />
              <span>{operatorMode ? t("operator.operatorNav") : tenantMode ? t("operator.tenantNav") : "Setup"}</span>
            </div>
            <div className="nav-group-links">
              {visibleNavItems.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.path}
                    className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
                    to={item.path}
                  >
                    <Icon size={14} />
                    <span>{t(item.labelKey)}</span>
                  </NavLink>
                );
              })}
            </div>
          </div>
        </nav>

        <div className="sidebar-footer">
          <div className="runtime-status" role="status" aria-live="polite">
            <StatusDot ok={!props.error} />
            <div className="runtime-status-copy">
              <strong>{props.error ? t("common.apiUnavailable") : t("common.runtimeReady")}</strong>
            </div>
          </div>
          <div className="runtime-actions">
            <Button className="cc-button runtime-action" variant="outline" size="sm" onClick={props.onRefresh}>
              {props.loading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
              <span>{t("common.refresh")}</span>
            </Button>
            <Button className="cc-button runtime-action" variant="outline" size="sm" onClick={props.onLogout}>
              <LogOut size={15} />
              <span>{t("shell.logout")}</span>
            </Button>
          </div>
        </div>
      </aside>

      <div className={isBrowserPage ? "main-region main-region-browser" : "main-region"}>
        <header className="shell-header">
          <div className="shell-header-title">
            <h1>
              {operatorMode
                ? t("operator.workspaceTitle")
                : tenantMode
                  ? props.activeTenant?.displayName
                  : "Setup Agent"}
            </h1>
            {sharedRuntime ? (
              <span className="shell-context-badge">
                <span aria-hidden="true" />
                {operatorMode ? t("operator.operatorView") : t("operator.tenantView")}
              </span>
            ) : null}
          </div>
          {tenantMode ? (
            <Button className="cc-button" variant="outline" size="sm" onClick={props.onExitTenant}>
              <ArrowLeft size={15} />
              {t("operator.backToTenants")}
            </Button>
          ) : null}
          {props.loading ? (
            <div className="loading-panel page-loading">
              <Loader2 className="spin" size={16} />
              {t("common.loadingRuntimeData")}
            </div>
          ) : null}
        </header>

        <main className={mainClassName}>
          {props.error ? <InlineError message={props.error} /> : null}

          <ConsoleApiProvider tenantScoped={tenantMode}>
            <Routes>
              <Route index element={<Navigate to="/overview" replace />} />
              <Route
                path="/overview"
                element={
                  operatorMode ? (
                    <OperatorPage
                      tenants={props.operatorTenants ?? []}
                      loading={props.loading}
                      onRefresh={props.onRefresh}
                      onSelectTenant={props.onSelectTenant}
                    />
                  ) : (
                    <OverviewPage data={props.data} onRefresh={props.onRefresh} />
                  )
                }
              />
              {operatorMode ? (
                <>
                  <Route path="/oauth-apps" element={<OAuthAppsPage data={props.data} onRefresh={props.onRefresh} />} />
                  <Route path="/resources" element={<ResourcesPage />} />
                </>
              ) : (
                <>
                  <Route path="/providers" element={<ProvidersPage data={props.data} onRefresh={props.onRefresh} />} />
                  <Route
                    path="/providers/:service"
                    element={<ProvidersPage data={props.data} onRefresh={props.onRefresh} />}
                  />
                  {!tenantMode ? (
                    <Route
                      path="/oauth-apps"
                      element={<OAuthAppsPage data={props.data} onRefresh={props.onRefresh} />}
                    />
                  ) : null}
                  <Route path="/actions" element={<ActionsPage data={props.data} onRefresh={props.onRefresh} />} />
                  <Route
                    path="/actions/:actionId"
                    element={<ActionsPage data={props.data} onRefresh={props.onRefresh} />}
                  />
                  <Route
                    path="/runs"
                    element={
                      <RunsPage
                        initialRuns={props.data.runs}
                        nextCursor={props.data.runsNextCursor}
                        runsBasePath={consoleApiRoutes(tenantMode).runs}
                        onRefresh={props.onRefresh}
                      />
                    }
                  />
                  <Route
                    path="/access"
                    element={
                      <AccessPage
                        providers={props.data.providers}
                        connections={props.data.connections}
                        tokens={props.data.runtimeTokens}
                        policy={props.data.runtimePolicy ?? emptyData.runtimePolicy!}
                        policyEditable={!tenantMode}
                        onRefresh={props.onRefresh}
                      />
                    }
                  />
                  <Route path="/resources" element={<ResourcesPage />} />
                </>
              )}
              <Route path="*" element={<Navigate to="/overview" replace />} />
            </Routes>
          </ConsoleApiProvider>
        </main>
      </div>
    </div>
  );
}

export interface UnlockViewProps {
  loading: boolean;
  message: string | null;
  onUnlock(token: string): void;
}

export function UnlockView(props: UnlockViewProps): ReactNode {
  const t = useTranslate();
  const [token, setToken] = useState("");

  function submit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    props.onUnlock(token.trim());
  }

  return (
    <main className="unlock-screen">
      <section className="unlock-panel">
        <div className="brand">
          <img className="brand-mark" src={mitoriMarkUrl} alt="" />
          <div>
            <div className="brand-name">Mitori</div>
            <div className="brand-subtitle">{t("brand.adminAccess")}</div>
          </div>
        </div>
        <form className="form-grid" onSubmit={submit}>
          <Label className="field">
            <span>{t("unlock.token")}</span>
            <Input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoFocus
              autoComplete="current-password"
            />
          </Label>
          <Button
            className="unlock-submit"
            type="submit"
            data-loading={props.loading}
            aria-busy={props.loading}
            disabled={!token.trim() || props.loading}
          >
            <span className="unlock-button-slot">
              <Loader2
                className={props.loading ? "unlock-button-spinner spin" : "unlock-button-spinner idle"}
                size={16}
                aria-hidden="true"
              />
            </span>
            <span>{t("unlock.unlockConsole")}</span>
            <span className="unlock-button-slot" aria-hidden="true" />
          </Button>
        </form>
        {props.message ? (
          <div className="unlock-status" aria-live="polite">
            <InlineError message={props.message} />
          </div>
        ) : null}
      </section>
    </main>
  );
}

function headingForPath(pathname: string): string {
  const section = pathname.split("/").filter(Boolean)[0];
  if (section === "providers") {
    return "providers";
  }
  if (section === "oauth-apps") {
    return "oauthApps";
  }
  if (section === "actions") {
    return "actions";
  }
  if (section === "runs") {
    return "runs";
  }
  if (section === "access") {
    return "access";
  }
  if (section === "resources") {
    return "resources";
  }
  return "overview";
}
