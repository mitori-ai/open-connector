import type { ReactNode } from "react";

import { createContext, useContext } from "react";

export interface ConsoleApiRoutes {
  tenantScoped: boolean;
  providers: string;
  actions: string;
  connections: string;
  oauthAuthorizations: string;
  oauthCompletions: string;
  runtimeTokens: string;
  runs: string;
  actionRun(actionId: string): string;
}

const localConsoleRoutes: ConsoleApiRoutes = {
  tenantScoped: false,
  providers: "/api/providers",
  actions: "/api/actions",
  connections: "/api/connections",
  oauthAuthorizations: "/api/oauth/authorizations",
  oauthCompletions: "/api/oauth/completions",
  runtimeTokens: "/api/runtime-tokens",
  runs: "/api/runs",
  actionRun: (actionId) => `/v1/actions/${encodeURIComponent(actionId)}`,
};

const tenantConsoleRoutes: ConsoleApiRoutes = {
  tenantScoped: true,
  providers: "/api/tenant/providers",
  actions: "/api/tenant/actions",
  connections: "/api/tenant/connections",
  oauthAuthorizations: "/api/tenant/oauth/authorizations",
  oauthCompletions: "/api/tenant/oauth/completions",
  runtimeTokens: "/api/tenant/runtime-tokens",
  runs: "/api/tenant/runs",
  actionRun: (actionId) => `/api/tenant/actions/${encodeURIComponent(actionId)}/run`,
};

const ConsoleApiContext = createContext(localConsoleRoutes);

export function ConsoleApiProvider(props: { tenantScoped: boolean; children: ReactNode }): ReactNode {
  return (
    <ConsoleApiContext.Provider value={props.tenantScoped ? tenantConsoleRoutes : localConsoleRoutes}>
      {props.children}
    </ConsoleApiContext.Provider>
  );
}

export function useConsoleApiRoutes(): ConsoleApiRoutes {
  return useContext(ConsoleApiContext);
}

export function consoleApiRoutes(tenantScoped: boolean): ConsoleApiRoutes {
  return tenantScoped ? tenantConsoleRoutes : localConsoleRoutes;
}
