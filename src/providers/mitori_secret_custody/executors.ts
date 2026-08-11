import type { CredentialValidationResult, CredentialValidators, ProviderExecutors } from "../../core/types.ts";

const service = "mitori_secret_custody";
const maxPurposeLength = 255;

/**
 * Secret custody has no runtime capability by design. The connection is an
 * admin-only encrypted record, not a credential an action may resolve.
 */
export const executors: ProviderExecutors = {};

export const credentialValidators: CredentialValidators = {
  async customCredential(input): Promise<CredentialValidationResult> {
    const payload = input.values.payload;
    if (!payload) {
      throw new Error("payload is required.");
    }

    try {
      const parsed: unknown = JSON.parse(payload);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("payload must be a JSON object.");
      }
    } catch (error) {
      if (error instanceof Error && error.message === "payload must be a JSON object.") {
        throw error;
      }
      throw new Error("payload must contain valid JSON.");
    }

    const purpose = input.values.purpose;
    if (!purpose) {
      throw new Error("purpose is required.");
    }
    if (
      purpose.length > maxPurposeLength ||
      [...purpose].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint < 32 || codePoint === 127;
      })
    ) {
      throw new Error("purpose must be a safe label of at most 255 characters.");
    }

    return {
      profile: {
        // Purpose is explicitly non-secret; the payload is never used in the
        // profile or any other validator result.
        accountId: `${service}:purpose:${purpose}`,
        displayName: "Mitori Secret Custody",
        grantedScopes: [],
      },
    };
  },
};
