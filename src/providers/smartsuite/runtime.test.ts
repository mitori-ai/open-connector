import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderRequestError } from "../provider-runtime.ts";
import { smartsuiteActions } from "./actions.ts";
import { configureSmartsuiteRecordResponseLimit } from "./config.ts";
import { executeSmartsuiteAction } from "./runtime.ts";

const apiKey = "smartsuite-secret-api-key";
const workspaceId = "workspace-secret-id";

describe("SmartSuite compatibility runtime", () => {
  afterEach(() => {
    configureSmartsuiteRecordResponseLimit(undefined);
  });

  it.each(["list_records", "search_records"])("accepts %s pages larger than 1 MiB by default", async (actionName) => {
    const record = { id: "record-1", description: "x".repeat(2 * 1024 * 1024) };
    const fetcher = vi.fn(async (_request: RequestInfo | URL) =>
      Response.json({ items: [record], total: 1, offset: 0, limit: 1000 }),
    );

    const result = await executeSmartsuiteAction(
      { apiKey, values: { workspaceId }, actionName, input: { tableId: "table-1", limit: 1000, filter: {} } },
      fetcher as typeof fetch,
    );

    expect(result).toEqual({ records: [record], total: 1, offset: 0, limit: 1000 });
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get("limit")).toBe("1000");
  });

  it("enforces the 20 MiB default against the declared response length", async () => {
    const fetcher = vi.fn(
      async () => new Response("{}", { headers: { "content-length": String(20 * 1024 * 1024 + 1) } }),
    );
    await expect(executeListRecords(fetcher as typeof fetch)).rejects.toMatchObject({
      status: 413,
      message: "SmartSuite response exceeds 20971520 bytes",
    });
  });

  it("honors a larger configured limit", async () => {
    configureSmartsuiteRecordResponseLimit(String(32 * 1024 * 1024));
    const record = { id: "record-1", description: "x".repeat(21 * 1024 * 1024) };
    const fetcher = vi.fn(async () => Response.json({ items: [record], total: 1, offset: 0, limit: 1000 }));
    await expect(executeListRecords(fetcher as typeof fetch)).resolves.toMatchObject({ records: [record] });
  });

  it("cancels a streamed response when it exceeds the configured limit without a Content-Length header", async () => {
    configureSmartsuiteRecordResponseLimit("32");
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(20)));
      },
      cancel,
    });
    const fetcher = vi.fn(async () => new Response(stream));
    await expect(executeListRecords(fetcher as typeof fetch)).rejects.toMatchObject({
      status: 413,
      message: "SmartSuite response exceeds 32 bytes",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["", "0", "-1", "1.5", "Infinity", "NaN", "9007199254740992", "20MiB"])(
    "rejects an invalid response limit %j",
    (value) => {
      expect(() => configureSmartsuiteRecordResponseLimit(value)).toThrow(
        "OOMOL_CONNECT_SMARTSUITE_RECORD_MAX_RESPONSE_BYTES must be a positive safe integer",
      );
    },
  );

  it("keeps provider error bodies bounded to 1 MiB with a larger record limit", async () => {
    configureSmartsuiteRecordResponseLimit(String(32 * 1024 * 1024));
    const fetcher = vi.fn(async () => new Response("x".repeat(1024 * 1024 + 1), { status: 500 }));
    await expect(executeListRecords(fetcher as typeof fetch)).rejects.toMatchObject({
      status: 413,
      message: "SmartSuite response exceeds 1048576 bytes",
    });
  });

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

  it("hydrates ID-only Assigned To values from the workspace member list", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () =>
        Response.json({
          items: [
            { id: "record-1", assigned_to: ["member-jin"] },
            { id: "record-2", assigned_to: ["member-unknown"] },
          ],
          total: 2,
          offset: 0,
          limit: 100,
        }),
      )
      .mockImplementationOnce(async () =>
        Response.json({
          items: [
            {
              id: "member-jin",
              full_name: { first_name: "Jin", last_name: "Kuk", sys_root: "Jin Kuk" },
              email: ["jin@mitori.ai"],
            },
          ],
          total: 1,
          offset: 0,
          limit: 1000,
        }),
      );

    await expect(
      executeSmartsuiteAction(
        {
          apiKey,
          values: { workspaceId },
          actionName: "list_records",
          input: { tableId: "table-1", hydrated: true },
        },
        fetchMock as typeof fetch,
      ),
    ).resolves.toEqual({
      records: [
        { id: "record-1", assigned_to: [{ id: "member-jin", displayName: "Jin Kuk" }] },
        { id: "record-2", assigned_to: ["member-unknown"] },
      ],
      total: 2,
      offset: 0,
      limit: 100,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [memberRequest, memberInit] = fetchMock.mock.calls[1]!;
    expect(new URL(String(memberRequest)).toString()).toBe(
      "https://app.smartsuite.com/api/v1/members/list/?offset=0&limit=1000",
    );
    expect(JSON.parse(String(memberInit?.body))).toEqual({ sort: [], filter: {} });
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

function executeListRecords(fetcher: typeof fetch): Promise<unknown> {
  return executeSmartsuiteAction(
    { apiKey, values: { workspaceId }, actionName: "list_records", input: { tableId: "table-1", limit: 1000 } },
    fetcher,
  );
}

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
