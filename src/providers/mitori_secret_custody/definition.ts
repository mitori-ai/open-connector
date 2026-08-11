import type { ProviderDefinition } from "../../core/types.ts";

const service = "mitori_secret_custody";

/**
 * Private admin-only storage provider for opaque Mitori secret bundles.
 *
 * This provider deliberately exposes no actions: its custom credential is only
 * a durable encrypted connection record, never a runtime capability.
 */
export const provider: ProviderDefinition = {
  service,
  displayName: "Mitori Secret Custody",
  description: "Private admin-only encrypted storage for opaque Mitori secret bundles.",
  categories: ["Security"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        {
          key: "payload",
          label: "Secret JSON payload",
          inputType: "json",
          required: true,
          secret: true,
          description: "Opaque JSON serialized by the administrator and retained only in encrypted connection storage.",
        },
        {
          key: "purpose",
          label: "Purpose",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "start-input",
          description: "Short non-secret label describing why this secret bundle is stored.",
        },
      ],
    },
  ],
  actions: [],
};
