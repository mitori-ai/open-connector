import type { ProviderDefinition } from "../../core/types.ts";

import { airspaceActions } from "./actions.ts";

export const provider: ProviderDefinition = {
  service: "airspace",
  displayName: "Airspace",
  description: "Monitor Airspace orders and shipment events through the official v3 API.",
  categories: ["Logistics", "Data"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "API Token",
      placeholder: "Airspace API token",
      description:
        "Bearer token issued by Airspace. Contact integrations@airspace.com to request test and production API access: https://api.airspace.com/api-docs/v3.",
      extraFields: [
        {
          key: "environment",
          label: "Environment",
          inputType: "text",
          required: false,
          secret: false,
          placeholder: "production",
          description: "Use production or test. The connector defaults to production when omitted.",
        },
      ],
    },
  ],
  homepageUrl: "https://www.airspace.com",
  actions: airspaceActions,
};
