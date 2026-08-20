import type { CredentialValidators, ExecutionContext, ProviderExecutors } from "../../core/types.ts";
import type { AirspaceContext } from "./runtime.ts";

import { optionalString } from "../../core/cast.ts";
import { defineProviderExecutors, requireApiKeyCredential } from "../provider-runtime.ts";
import { airspaceActionHandlers, readAirspaceEnvironment, validateAirspaceCredential } from "./runtime.ts";

const service = "airspace";

export const executors: ProviderExecutors = defineProviderExecutors<AirspaceContext>({
  service,
  handlers: airspaceActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<AirspaceContext> {
    const credential = await requireApiKeyCredential(context, service);
    return {
      apiKey: credential.apiKey,
      environment: readAirspaceEnvironment(
        optionalString(credential.values.environment) ?? optionalString(credential.metadata.environment),
      ),
      fetcher,
      signal: context.signal,
    };
  },
});

export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher, signal }) {
    return validateAirspaceCredential(input, fetcher, signal);
  },
};
