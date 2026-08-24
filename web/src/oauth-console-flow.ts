export const oauthCompletionChannelName = "oomol-connect-oauth";
export const oauthCompletedType = "oauth.completed";
export const oauthConsoleCompletionPath = "/console/oauth-complete";

const oauthConsoleStoragePrefix = "oomol-connect-oauth-flow:";

export interface OAuthConsoleFlow {
  id: string;
  service: string;
  sessionCorrelation: string;
  returnUrl: string;
  storageKey: string;
}

export function createOAuthConsoleFlow(origin: string, service: string): OAuthConsoleFlow {
  const id = crypto.randomUUID();
  const sessionCorrelation = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  const returnUrl = new URL(oauthConsoleCompletionPath, origin);
  returnUrl.searchParams.set("flow", id);
  returnUrl.searchParams.set("service", service);
  return {
    id,
    service,
    sessionCorrelation,
    returnUrl: returnUrl.toString(),
    storageKey: oauthConsoleStorageKey(id),
  };
}

export function oauthConsoleStorageKey(flowId: string): string {
  return `${oauthConsoleStoragePrefix}${flowId}`;
}
