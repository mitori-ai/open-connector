import { describe, expect, it, vi } from "vitest";
import { ProviderRequestError } from "../provider-runtime.ts";
import { smartsuiteActions } from "./actions.ts";
import { executeSmartsuiteAction } from "./runtime.ts";

const apiKey = "smartsuite-secret-api-key";
const workspaceId = "workspace-secret-id";

describe("SmartSuite compatibility runtime", () => {
  it("keeps search_records and the all compatibility input", async () => {
    expect(smartsuiteActions.map((action) => action.name)).toContain("search_records");
    const fetchMock = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ items: [], total: 0, offset: 10, limit: 25 }),
    );
    const fetcher = fetchMock as typeof fetch;

    await expect(
      executeSmartsuiteAction(
        {
          apiKey,
          values: { workspaceId },
          actionName: "search_records",
          input: {
            tableId: "table-1",
            offset: 10,
            limit: 25,
            all: true,
            filter: { operator: "and", fields: [] },
          },
        },
        fetcher,
      ),
    ).resolves.toEqual({ records: [], total: 0, offset: 10, limit: 25 });

    const [request, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(request)).searchParams.get("all")).toBe("true");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({ filter: { operator: "and", fields: [] } });
  });

  it("redacts API keys and workspace IDs from provider and transport errors", async () => {
    const providerFetcher = vi.fn(async () =>
      Response.json({ message: `echoed ${apiKey} and ${workspaceId}` }, { status: 400 }),
    ) as typeof fetch;
    const providerError = await captureError(() => executeGetRecord(providerFetcher));
    expect(providerError.message).toContain("[redacted]");
    expect(providerError.message).not.toContain(apiKey);
    expect(providerError.message).not.toContain(workspaceId);

    const transportFetcher = vi.fn(async () => {
      throw new Error(`transport echoed ${apiKey} and ${workspaceId}`);
    }) as typeof fetch;
    const transportError = await captureError(() => executeGetRecord(transportFetcher));
    expect(transportError.message).not.toContain(apiKey);
    expect(transportError.message).not.toContain(workspaceId);
  });

  it("redacts secrets from transport ProviderRequestError messages and details", async () => {
    const fetcher = vi.fn(async () => {
      throw new ProviderRequestError(429, `echoed ${apiKey} and ${workspaceId}`, {
        apiKey,
        nested: { workspaceId, retryAfter: 60 },
        messages: [`retry ${apiKey}`, workspaceId],
      });
    }) as typeof fetch;

    const error = await captureError(() => executeGetRecord(fetcher));
    expect(error).toBeInstanceOf(ProviderRequestError);
    const providerError = error as ProviderRequestError;
    expect(providerError.status).toBe(429);
    expect(providerError.message).toBe("echoed [redacted] and [redacted]");
    expect(providerError.details).toEqual({
      apiKey: "[redacted]",
      nested: { workspaceId: "[redacted]", retryAfter: 60 },
      messages: ["retry [redacted]", "[redacted]"],
    });
    expect(JSON.stringify(providerError.details)).not.toContain(apiKey);
    expect(JSON.stringify(providerError.details)).not.toContain(workspaceId);
  });

  it("rejects oversized provider errors without echoing their body", async () => {
    const marker = "smartsuite-oversized-body-marker";
    const fetcher = vi.fn(
      async () => new Response(`${"x".repeat(1024 * 1024)}${marker}`, { status: 500 }),
    ) as typeof fetch;

    const error = await captureError(() => executeGetRecord(fetcher));
    expect(error.message).not.toContain(marker);
    expect(error.message).toContain("exceeds 1048576 bytes");
  });
});

function executeGetRecord(fetcher: typeof fetch): Promise<unknown> {
  return executeSmartsuiteAction(
    {
      apiKey,
      values: { workspaceId },
      actionName: "get_record",
      input: { tableId: "table-1", recordId: "record-1" },
    },
    fetcher,
  );
}

async function captureError(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("Expected operation to fail");
}
