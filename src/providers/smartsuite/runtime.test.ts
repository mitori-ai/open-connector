import { describe, expect, it, vi } from "vitest";
import { provider } from "./definition.ts";
import { smartsuiteActionHandlers, smartsuiteInternals, validateSmartSuiteCredential } from "./runtime.ts";

const apiKey = "smartsuite-test-api-key";
const workspaceId = "sv25cxf2";
const tableId = "6451093119bcf22befaed847";
const recordId = "645109df887911e1871054b7";

function context(fetcher: typeof fetch) {
  return { apiKey, workspaceId, fetcher };
}

function response(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

describe("SmartSuite provider catalog", () => {
  it("exposes stable record actions and workspace credential metadata", () => {
    expect(provider.service).toBe("smartsuite");
    expect(provider.authTypes).toEqual(["api_key"]);
    expect(provider.auth[0]).toMatchObject({
      type: "api_key",
      extraFields: [{ key: "workspaceId", required: true, secret: false }],
    });
    expect(provider.actions.map((action) => action.id)).toEqual([
      "smartsuite.list_records",
      "smartsuite.search_records",
      "smartsuite.get_record",
      "smartsuite.update_record",
    ]);
  });
});

describe("SmartSuite runtime", () => {
  it("validates an API key with the official workspace-scoped endpoint without returning secrets", async () => {
    const fetcher = vi.fn(async (): Promise<Response> => response({ items: [] }));

    await expect(validateSmartSuiteCredential({ apiKey, values: { workspaceId } }, fetcher)).resolves.toEqual({
      profile: {
        accountId: workspaceId,
        displayName: `SmartSuite workspace ${workspaceId}`,
      },
      grantedScopes: [],
      metadata: {
        apiBaseUrl: "https://app.smartsuite.com/api/v1",
        validationEndpoint: "/solutions/",
        workspaceId,
      },
    });

    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://app.smartsuite.com/api/v1/solutions/");
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({
      authorization: `Token ${apiKey}`,
      "account-id": workspaceId,
      accept: "application/json",
    });
    expect(JSON.stringify(fetcher.mock.calls[0])).not.toContain("[redacted]");
  });

  it("lists records through the official POST endpoint with bounded pagination and typed directives", async () => {
    const fetcher = vi.fn(
      async (): Promise<Response> =>
        response({
          total: 1,
          offset: 10,
          limit: 2,
          items: [{ id: recordId, title: "Ticket", api_key: "provider must not leak" }],
        }),
    );

    const output = await smartsuiteActionHandlers.list_records(
      {
        tableId,
        offset: 10,
        limit: 2,
        all: true,
        hydrated: true,
        sort: [{ field: "title", direction: "asc" }],
        filter: {
          operator: "and",
          fields: [{ field: "status", comparison: "is_not", value: "Complete" }],
        },
      },
      context(fetcher),
    );

    expect(output).toEqual({
      records: [{ id: recordId, title: "Ticket" }],
      total: 1,
      offset: 10,
      limit: 2,
    });
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://app.smartsuite.com/api/v1/applications/6451093119bcf22befaed847/records/list/?offset=10&limit=2&all=true",
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: `Token ${apiKey}`, "account-id": workspaceId });
    expect(JSON.parse(String(init.body))).toEqual({
      sort: [{ field: "title", direction: "asc" }],
      filter: {
        operator: "and",
        fields: [{ field: "status", comparison: "is_not", value: "Complete" }],
      },
      hydrated: true,
    });
  });

  it("searches with a required filter and gets a record with the documented endpoint shapes", async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        async (): Promise<Response> => response({ total: 1, offset: 0, limit: 100, items: [{ id: recordId }] }),
      )
      .mockImplementationOnce(async (): Promise<Response> => response({ id: recordId, title: "Ticket" }));

    await expect(
      smartsuiteActionHandlers.search_records(
        {
          tableId,
          filter: { operator: "or", fields: [{ field: "title", comparison: "contains", value: "Ticket" }] },
        },
        context(fetcher),
      ),
    ).resolves.toEqual({ records: [{ id: recordId }], total: 1, offset: 0, limit: 100 });

    await expect(
      smartsuiteActionHandlers.get_record({ tableId, recordId, hydrated: true }, context(fetcher)),
    ).resolves.toEqual({
      record: { id: recordId, title: "Ticket" },
    });

    const [searchUrl, searchInit] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(searchUrl.toString()).toBe(
      "https://app.smartsuite.com/api/v1/applications/6451093119bcf22befaed847/records/list/?limit=100",
    );
    expect(JSON.parse(String(searchInit.body))).toEqual({
      sort: [],
      filter: { operator: "or", fields: [{ field: "title", comparison: "contains", value: "Ticket" }] },
    });
    const [getUrl, getInit] = fetcher.mock.calls[1] as unknown as [URL, RequestInit];
    expect(getUrl.toString()).toBe(
      "https://app.smartsuite.com/api/v1/applications/6451093119bcf22befaed847/records/645109df887911e1871054b7/?hydrated=true",
    );
    expect(getInit.method).toBe("GET");
  });

  it("patches only explicit mutable fields and rejects documented system-generated fields", async () => {
    const fetcher = vi.fn(async (): Promise<Response> => response({ id: recordId, title: "Updated" }));

    await expect(
      smartsuiteActionHandlers.update_record(
        { tableId, recordId, fields: { title: "Updated", status: { value: "done" } } },
        context(fetcher),
      ),
    ).resolves.toEqual({ record: { id: recordId, title: "Updated" } });
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://app.smartsuite.com/api/v1/applications/6451093119bcf22befaed847/records/645109df887911e1871054b7/",
    );
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ title: "Updated", status: { value: "done" } });

    await expect(
      smartsuiteActionHandlers.update_record(
        { tableId, recordId, fields: { "First Created": "nope" } },
        context(fetcher),
      ),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("system-generated") });
    await expect(
      smartsuiteActionHandlers.update_record({ tableId, recordId, fields: {} }, context(fetcher)),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not expose API key or workspace ID in credential failures", async () => {
    const fetcher = vi.fn(
      async (): Promise<Response> => response({ detail: `bad ${apiKey} ${workspaceId}` }, { status: 401 }),
    );

    await expect(validateSmartSuiteCredential({ apiKey, values: { workspaceId } }, fetcher)).rejects.toMatchObject({
      status: 400,
      message: "SmartSuite credentials were rejected",
    });
    await expect(validateSmartSuiteCredential({ apiKey, values: {} }, fetcher)).rejects.toMatchObject({
      status: 400,
      message: "workspaceId is required",
    });
  });

  it("normalizes path-safe identifiers and caps record update fields", async () => {
    expect(smartsuiteInternals.buildSmartSuiteUrl("/applications/a/records/list/", { limit: 100 }).toString()).toBe(
      "https://app.smartsuite.com/api/v1/applications/a/records/list/?limit=100",
    );
    expect(() => smartsuiteInternals.readUpdateFields({})).toThrow("at least one");
    expect(() => smartsuiteInternals.readUpdateFields({ formula: "x" })).toThrow("system-generated");
  });
});
