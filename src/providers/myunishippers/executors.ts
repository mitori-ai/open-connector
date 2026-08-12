import type { ExecutionContext, ProviderExecutors } from "../../core/types.ts";

import { defineProviderExecutors } from "../provider-runtime.ts";
import { myUnishippersActionHandlers } from "./runtime.ts";

interface MyUnishippersContext {
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

export const executors: ProviderExecutors = defineProviderExecutors<MyUnishippersContext>({
  service: "myunishippers",
  handlers: myUnishippersActionHandlers,
  createContext(context: ExecutionContext, fetcher: typeof fetch): MyUnishippersContext {
    return { fetcher, signal: context.signal };
  },
});
