import type { ProviderDefinition } from "../../core/types.ts";

import { helpscoutActions } from "./actions.ts";

const service = "helpscout";

/**
 * Help Scout core Mailbox API provider backed by the official OAuth 2.0 API.
 *
 * Mailbox API authentication is OAuth 2.0 only. The official documentation
 * does not define a scope string for this API, so the catalog advertises no
 * speculative scopes and lets Help Scout's OAuth application grant access.
 */
export const provider: ProviderDefinition = {
  service,
  displayName: "Help Scout",
  categories: ["Communication", "Productivity"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://secure.helpscout.net/authentication/authorizeClientApplication",
      tokenUrl: "https://api.helpscout.net/v2/oauth2/token",
      refreshTokenUrl: "https://api.helpscout.net/v2/oauth2/token",
      scopes: [],
      tokenEndpointAuthMethod: "client_secret_post",
    },
  ],
  homepageUrl: "https://www.helpscout.com",
  actions: helpscoutActions,
};
