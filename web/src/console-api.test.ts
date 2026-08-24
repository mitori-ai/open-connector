import { describe, expect, it } from "vitest";
import { consoleApiRoutes } from "./console-api";
import { createOAuthConsoleFlow, oauthConsoleStorageKey } from "./oauth-console-flow";

describe("consoleApiRoutes", () => {
  it("keeps the local console on the existing API routes", () => {
    const routes = consoleApiRoutes(false);
    expect(routes).toMatchObject({
      tenantScoped: false,
      providers: "/api/providers",
      connections: "/api/connections",
      runtimeTokens: "/api/runtime-tokens",
      runs: "/api/runs",
    });
    expect(routes.actionRun("gmail.send message")).toBe("/v1/actions/gmail.send%20message");
  });

  it("routes an operator tenant session through tenant-admin APIs", () => {
    const routes = consoleApiRoutes(true);
    expect(routes).toMatchObject({
      tenantScoped: true,
      providers: "/api/tenant/providers",
      connections: "/api/tenant/connections",
      runtimeTokens: "/api/tenant/runtime-tokens",
      runs: "/api/tenant/runs",
      oauthAuthorizations: "/api/tenant/oauth/authorizations",
      oauthCompletions: "/api/tenant/oauth/completions",
    });
    expect(routes.actionRun("gmail.send message")).toBe("/api/tenant/actions/gmail.send%20message/run");
  });
});

describe("createOAuthConsoleFlow", () => {
  it("binds the staged completion to one popup session", () => {
    const flow = createOAuthConsoleFlow("https://connector.example.test", "gmail");
    const returnUrl = new URL(flow.returnUrl);

    expect(returnUrl.origin).toBe("https://connector.example.test");
    expect(returnUrl.pathname).toBe("/console/oauth-complete");
    expect(returnUrl.searchParams.get("flow")).toBe(flow.id);
    expect(returnUrl.searchParams.get("service")).toBe("gmail");
    expect(flow.sessionCorrelation).toMatch(/^[a-f0-9]{64}$/u);
    expect(flow.storageKey).toBe(oauthConsoleStorageKey(flow.id));
  });
});
