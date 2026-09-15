import { describe, expect, it, vi } from "vitest";
import { ProviderRequestError } from "../provider-runtime.ts";
import { smartsuiteActions } from "./actions.ts";
import { executeSmartsuiteAction } from "./runtime.ts";

const apiKey = "smartsuite-secret-api-key";
const workspaceId = "workspace-secret-id";

describe("SmartSuite compatibility runtime", () => {
  it("does not expose SmartSuite record write actions", () => {
    const actionNames = smartsuiteActions.map((action) => action.name);

    expect(actionNames).not.toContain("create_record");
    expect(actionNames).not.toContain("bulk_create_records");
    expect(actionNames).not.toContain("change_field");
    expect(actionNames).not.toContain("update_record");
    expect(actionNames).not.toContain("delete_record");
  });

  it("reads complete table metadata with a GET and exposes normalized fields", async () => {
    expect(smartsuiteActions.map((action) => action.name)).toContain("get_table_metadata");
    const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(request)).toString()).toBe("https://app.smartsuite.com/api/v1/applications/table-1/");
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      return Response.json({
        id: "table-1",
        name: "Transportations",
        solution: "solution-1",
        structure: [
          {
            slug: "processing_facility",
            label: "Processing Facility",
            field_type: "singleselectfield",
            params: { choices: [{ label: "Atlanta", value: "facility-1" }] },
          },
          {
            slug: "link_to_shippers",
            label: "Link to NTP Shippers",
            field_type: "linkedrecordfield",
            params: { linked_application: "shippers-table", linked_field_slug: "title" },
          },
        ],
      });
    });

    await expect(
      executeSmartsuiteAction(
        {
          apiKey,
          values: { workspaceId },
          actionName: "get_table_metadata",
          input: { tableId: "table-1" },
        },
        fetchMock as typeof fetch,
      ),
    ).resolves.toMatchObject({
      table: { id: "table-1", name: "Transportations" },
      fields: [
        {
          slug: "processing_facility",
          field_type: "singleselectfield",
          params: { choices: [{ label: "Atlanta", value: "facility-1" }] },
        },
        {
          slug: "link_to_shippers",
          field_type: "linkedrecordfield",
          params: { linked_application: "shippers-table", linked_field_slug: "title" },
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("allows a bounded metadata response larger than the record response limit", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: "table-1",
        structure: [{ slug: "large_field", label: "x".repeat(1024 * 1024 + 1) }],
      }),
    );

    await expect(
      executeSmartsuiteAction(
        {
          apiKey,
          values: { workspaceId },
          actionName: "get_table_metadata",
          input: { tableId: "table-1" },
        },
        fetchMock as typeof fetch,
      ),
    ).resolves.toMatchObject({ fields: [{ slug: "large_field" }] });
  });

  it("normalizes fields_metadata maps without mutating the table response", async () => {
    const table = {
      id: "table-1",
      fields_metadata: {
        status: { label: "Status", field_type: "statusfield" },
      },
    };
    const fetchMock = vi.fn(async () => Response.json(table));

    await expect(
      executeSmartsuiteAction(
        {
          apiKey,
          values: { workspaceId },
          actionName: "get_table_metadata",
          input: { tableId: "table-1" },
        },
        fetchMock as typeof fetch,
      ),
    ).resolves.toEqual({
      table,
      fields: [{ slug: "status", label: "Status", field_type: "statusfield" }],
    });
    expect(table.fields_metadata.status).not.toHaveProperty("slug");
  });

  it.each([
    ["list_views", "/reports/", "views", [{ id: "view-1", label: "Dallas Scheduling", state: {} }]],
    ["list_folders", "/folders/", "folders", [{ id: "folder-1", label: "Dallas Scheduling" }]],
  ] as const)("reads %s with a GET and no request body", async (actionName, path, key, value) => {
    expect(smartsuiteActions.map((action) => action.name)).toContain(actionName);
    const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(request));
      expect(url.pathname).toBe(`/api/v1${path}`);
      expect(url.searchParams.get("application")).toBe("table-1");
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      return Response.json(value);
    });

    await expect(
      executeSmartsuiteAction(
        { apiKey, values: { workspaceId }, actionName, input: { tableId: "table-1" } },
        fetchMock as typeof fetch,
      ),
    ).resolves.toEqual({ [key]: value });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads one saved View with a GET and no request body", async () => {
    const view = { id: "view-1", label: "Shipper Inventory", view_mode: "dashboard", document: { type: "dashboard" } };
    const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(request)).toString()).toBe("https://app.smartsuite.com/api/v1/reports/view-1/");
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      return Response.json(view);
    });

    await expect(
      executeSmartsuiteAction(
        { apiKey, values: { workspaceId }, actionName: "get_view", input: { viewId: "view-1" } },
        fetchMock as typeof fetch,
      ),
    ).resolves.toEqual({ view });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads Dashboard widgets with a GET and no request body", async () => {
    const widgets = [{ id: "widget-1", widget_type: "grid", report: "report-1" }];
    const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(request));
      expect(url.pathname).toBe("/api/v1/dashboard/widgets/");
      expect(url.searchParams.get("report")).toBe("report-1");
      expect(url.searchParams.get("tab")).toBe("tab-1");
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      return Response.json(widgets);
    });

    await expect(
      executeSmartsuiteAction(
        {
          apiKey,
          values: { workspaceId },
          actionName: "list_dashboard_widgets",
          input: { reportId: "report-1", tabId: "tab-1" },
        },
        fetchMock as typeof fetch,
      ),
    ).resolves.toEqual({ widgets });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
            fields: ["title", "status"],
            filter: { operator: "and", fields: [] },
          },
        },
        fetcher,
      ),
    ).resolves.toEqual({ records: [], total: 0, offset: 10, limit: 25 });

    const [request, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(request)).searchParams.get("all")).toBe("true");
    expect(new URL(String(request)).searchParams.getAll("fields")).toEqual(["title", "status"]);
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
