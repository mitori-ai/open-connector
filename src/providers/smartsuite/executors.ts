import type { CredentialValidators, ExecutionContext, ProviderExecutors } from "../../core/types.ts";
import type { SmartSuiteContext } from "./runtime.ts";

import { optionalString } from "../../core/cast.ts";
import { defineProviderExecutors, ProviderRequestError, requireApiKeyCredential } from "../provider-runtime.ts";
import { smartsuiteActionHandlers, validateSmartSuiteCredential } from "./runtime.ts";

const service = "smartsuite";

export const executors: ProviderExecutors = defineProviderExecutors<SmartSuiteContext>({
  service,
  handlers: smartsuiteActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<SmartSuiteContext> {
    const credential = await requireApiKeyCredential(context, service);
    const workspaceId =
      optionalString(credential.values.workspaceId) ?? optionalString(credential.metadata.workspaceId);
    if (!workspaceId) {
      throw new ProviderRequestError(401, "Configure SmartSuite workspaceId credentials first.");
    }
    return {
      apiKey: credential.apiKey,
      workspaceId,
      fetcher,
      signal: context.signal,
    };
  },
});

export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher, signal }) {
    return validateSmartSuiteCredential(input, fetcher, signal);
  },
};
