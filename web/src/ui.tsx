import type {
  AppData,
  ConnectionRecord,
  OAuthConfig,
  ProviderDefinition,
  RunLogPage,
  RuntimePolicyState,
  RuntimeTokenSummary,
} from "./model";
import type { FormEvent, ReactNode } from "react";

import { useTranslate } from "@embra/i18n/react";
import {
  Activity,
  BookOpen,
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
import { ApiError, apiGet, apiPost } from "./api";
import mitoriMarkUrl from "./assets/mitori-mark.png";
import { emptyData } from "./model";
import { OAuthAppsPage } from "./oauth-apps-page";
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

const oauthCompletionChannelName = "oomol-connect-oauth";
const oauthCompletedType = "oauth.completed";

export interface AuthSession {
  adminAuthConfigured: boolean;
  authenticated: boolean;
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
    return { authSession, data: emptyData };
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
  };
}

export function App(): ReactNode {
  const t = useTranslate();
  // Keep the existing automatic theme application without exposing theme controls in the UI.
  useThemeMode();
  const [data, setData] = useState<AppData>(emptyData);
  const [authSession, setAuthSession] = useState<AuthSession>({
    adminAuthConfigured: false,
    authenticated: true,
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
      .then(({ authSession: session, data: nextData }) => {
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
          setAuthSession({ adminAuthConfigured: true, authenticated: false });
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

  if (locked) {
    return <UnlockView loading={loading} message={error} onUnlock={unlock} />;
  }

  if (!runtimeChecked) {
    return <InitialLoadingView />;
  }

  return <AppShell data={data} loading={loading} error={error} onRefresh={refresh} onLogout={logout} />;
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
  loading: boolean;
  error: string | null;
  onRefresh(): void;
  onLogout(): void;
}): ReactNode {
  const t = useTranslate();
  const location = useLocation();
  const heading = headingForPath(location.pathname);
  const section = location.pathname.split("/").filter(Boolean)[0];
  const isOverviewPage = heading === "overview";
  const isBrowserPage = section === "actions" || section === "runs";
  const isRunsPage = section === "runs";
  const mainClassName = [
    isBrowserPage ? "main main-browser" : "main",
    isOverviewPage ? "overview-main" : "",
    isRunsPage ? "runs-main" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src={mitoriMarkUrl} alt="" />
          <div>
            <div className="brand-name">Mitori</div>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label={t("shell.primaryNav")}>
          <div className="nav-group">
            <div className="nav-group-label">
              <span className="nav-group-dot" aria-hidden="true" />
              <span>Setup</span>
            </div>
            <div className="nav-group-links">
              {navItems.map((item) => {
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
            <h1>Setup Agent</h1>
          </div>
          {props.loading ? (
            <div className="loading-panel page-loading">
              <Loader2 className="spin" size={16} />
              {t("common.loadingRuntimeData")}
            </div>
          ) : null}
        </header>

        <main className={mainClassName}>
          {props.error ? <InlineError message={props.error} /> : null}

          <Routes>
            <Route index element={<Navigate to="/overview" replace />} />
            <Route path="/overview" element={<OverviewPage data={props.data} onRefresh={props.onRefresh} />} />
            <Route path="/providers" element={<ProvidersPage data={props.data} onRefresh={props.onRefresh} />} />
            <Route
              path="/providers/:service"
              element={<ProvidersPage data={props.data} onRefresh={props.onRefresh} />}
            />
            <Route path="/oauth-apps" element={<OAuthAppsPage data={props.data} onRefresh={props.onRefresh} />} />
            <Route path="/actions" element={<ActionsPage data={props.data} onRefresh={props.onRefresh} />} />
            <Route path="/actions/:actionId" element={<ActionsPage data={props.data} onRefresh={props.onRefresh} />} />
            <Route
              path="/runs"
              element={
                <RunsPage
                  initialRuns={props.data.runs}
                  nextCursor={props.data.runsNextCursor}
                  onRefresh={props.onRefresh}
                />
              }
            />
            <Route
              path="/access"
              element={
                <AccessPage
                  providers={props.data.providers}
                  tokens={props.data.runtimeTokens}
                  policy={props.data.runtimePolicy ?? emptyData.runtimePolicy!}
                  onRefresh={props.onRefresh}
                />
              }
            />
            <Route path="/resources" element={<ResourcesPage />} />
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
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

  function submit(event: FormEvent): void {
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
