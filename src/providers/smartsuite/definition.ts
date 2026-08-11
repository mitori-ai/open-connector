import type { ProviderDefinition } from "../../core/types.ts";

import { smartsuiteActions } from "./actions.ts";

const service = "smartsuite";

export const provider: ProviderDefinition = {
  service,
  displayName: "SmartSuite",
  description: "Read and update SmartSuite table records through the official REST API.",
  categories: ["Productivity", "Data"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "API Key",
      placeholder: "SmartSuite API key",
      description:
        "SmartSuite API token sent as Authorization: Token <key>. Generate it from your SmartSuite profile. The key acts as the member account and must be treated like a password: https://developers.smartsuite.com/docs/authentication.",
      extraFields: [
        {
          key: "workspaceId",
          label: "Workspace ID",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "sv25cxf2",
          description:
            "The 8-character SmartSuite workspace ID sent as the Account-Id header. It is the first path segment after https://app.smartsuite.com/: https://help.smartsuite.com/en/articles/6096587-retrieving-your-api-key-and-workspace-id.",
        },
      ],
    },
  ],
  homepageUrl: "https://www.smartsuite.com",
  actions: smartsuiteActions,
};
