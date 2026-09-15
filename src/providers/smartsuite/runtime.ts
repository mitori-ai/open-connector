import { optionalBoolean, optionalInteger, optionalRecord, optionalString } from "../../core/cast.ts";
import { jsonObject } from "../../core/request.ts";
import {
  createProviderTimeout,
  ProviderRequestError,
  providerUserAgent,
  readProviderTextBody,
} from "../provider-runtime.ts";

interface ApiKeyProviderActionInput {
  apiKey: string;
  values: Record<string, string>;
  actionName: string;
  input: Record<string, unknown>;
}

export const smartsuiteApiBaseUrl = "https://app.smartsuite.com/api/v1";
const smartsuiteRequestTimeoutMs = 30_000;
const smartsuiteMaxResponseBytes = 1024 * 1024;
const smartsuiteMetadataMaxResponseBytes = 20 * 1024 * 1024;
const smartsuiteReplicaWorkspaceId = "se4hznb4";

interface SmartsuiteActionInput extends ApiKeyProviderActionInput {
  actionName: string;
}

interface SmartsuiteRequestInput {
  apiKey: string;
  workspaceId: string;
  path: string;
  fetcher: typeof fetch;
  method?: string;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  phase: "validate" | "execute";
  allowEmpty?: boolean;
  maxResponseBytes?: number;
}

type SmartsuiteRequest = (
  options: Omit<SmartsuiteRequestInput, "apiKey" | "workspaceId" | "fetcher" | "phase">,
) => Promise<unknown>;

export async function validateSmartsuiteCredential(
  input: Record<string, string>,
  fetcher: typeof fetch,
): Promise<{ accountLabel: string; providerScopes: string[]; providerMetadata: Record<string, unknown> }> {
  const workspaceId = readWorkspaceId(input);
  await requestSmartsuite({
    apiKey: input.apiKey,
    workspaceId,
    path: "/solutions/",
    fetcher,
    phase: "validate",
  });

  return {
    accountLabel: `SmartSuite workspace ${workspaceId}`,
    providerScopes: [],
    providerMetadata: {
      apiBaseUrl: smartsuiteApiBaseUrl,
      workspaceId,
      validationEndpoint: "/solutions/",
    },
  };
}

export async function executeSmartsuiteAction(input: SmartsuiteActionInput, fetcher: typeof fetch): Promise<unknown> {
  const apiKey = input.apiKey;
  const workspaceId = readWorkspaceId(input.values);
  const request = (options: Omit<SmartsuiteRequestInput, "apiKey" | "workspaceId" | "fetcher" | "phase">) =>
    requestSmartsuite({
      apiKey,
      workspaceId,
      fetcher,
      phase: "execute",
      ...options,
    });

  switch (input.actionName) {
    case "list_solutions":
      return { solutions: requireArray(await request({ path: "/solutions/" }), "solutions") };
    case "list_tables": {
      const solutionId = optionalString(input.input.solutionId);
      return {
        tables: requireArray(await request({ path: "/applications/", query: { solution: solutionId } }), "tables"),
      };
    }
    case "get_table_metadata": {
      const table = requireObject(
        await request({
          path: `/applications/${encodeURIComponent(readRequiredString(input.input.tableId, "tableId"))}/`,
          method: "GET",
          maxResponseBytes: smartsuiteMetadataMaxResponseBytes,
        }),
        "table metadata",
      );
      const fields = readTableMetadataFields(table);
      return { table, fields };
    }
    case "list_views": {
      const tableId = readRequiredString(input.input.tableId, "tableId");
      return {
        views: requireArray(
          await request({
            path: "/reports/",
            query: { application: tableId },
            maxResponseBytes: smartsuiteMetadataMaxResponseBytes,
          }),
          "views",
        ),
      };
    }
    case "get_view": {
      const viewId = readRequiredString(input.input.viewId, "viewId");
      return {
        view: requireObject(
          await request({
            path: `/reports/${encodeURIComponent(viewId)}/`,
            method: "GET",
            maxResponseBytes: smartsuiteMetadataMaxResponseBytes,
          }),
          "view",
        ),
      };
    }
    case "list_dashboard_widgets": {
      const reportId = readRequiredString(input.input.reportId, "reportId");
      return {
        widgets: requireArray(
          await request({
            path: "/dashboard/widgets/",
            query: { report: reportId, tab: optionalString(input.input.tabId) },
            maxResponseBytes: smartsuiteMetadataMaxResponseBytes,
          }),
          "dashboard widgets",
        ),
      };
    }
    case "list_folders": {
      const tableId = readRequiredString(input.input.tableId, "tableId");
      return {
        folders: requireArray(
          await request({
            path: "/folders/",
            query: { application: tableId },
            maxResponseBytes: smartsuiteMetadataMaxResponseBytes,
          }),
          "folders",
        ),
      };
    }
    case "list_records":
    case "search_records": {
      const tableId = readRequiredString(input.input.tableId, "tableId");
      const hydrated = optionalBoolean(input.input.hydrated);
      const payload = optionalRecord(
        await request({
          path: `/applications/${encodeURIComponent(tableId)}/records/list/`,
          method: "POST",
          query: jsonObject({
            offset: stringifyOptionalInteger(optionalInteger(input.input.offset)),
            limit: stringifyOptionalInteger(optionalInteger(input.input.limit)),
            all: stringifyOptionalBoolean(
              optionalBoolean(input.input.includeDeleted) ?? optionalBoolean(input.input.all),
            ),
            fields: readOptionalStringArray(input.input.fields),
          }),
          body: jsonObject({
            hydrated,
            sort: input.input.sort,
            filter: input.input.filter,
          }),
        }),
      );
      if (!payload || !Array.isArray(payload.items)) {
        throw invalidPayload("record list response did not include items");
      }
      const records =
        hydrated === true && payload.items.length > 0
          ? await hydrateAssignedToRecords(payload.items, request)
          : payload.items;
      return {
        total: readRequiredInteger(payload.total, "total"),
        offset: readRequiredInteger(payload.offset, "offset"),
        limit: readRequiredInteger(payload.limit, "limit"),
        records,
      };
    }
    case "get_record": {
      const { tableId, recordId } = readRecordIdentity(input.input);
      return {
        record: requireObject(
          await request({
            path: `/applications/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}/`,
            query: {
              hydrated: stringifyOptionalBoolean(optionalBoolean(input.input.hydrated)),
            },
          }),
          "record",
        ),
      };
    }
    case "create_record": {
      requireReplicaWorkspace(workspaceId, "create_record");
      const tableId = readRequiredString(input.input.tableId, "tableId");
      return {
        record: requireObject(
          await request({
            path: `/applications/${encodeURIComponent(tableId)}/records/`,
            method: "POST",
            body: requireInputObject(input.input.fields, "fields"),
            maxResponseBytes: smartsuiteMetadataMaxResponseBytes,
          }),
          "created record",
        ),
      };
    }
    case "bulk_create_records": {
      requireReplicaWorkspace(workspaceId, "bulk_create_records");
      const tableId = readRequiredString(input.input.tableId, "tableId");
      const records = requireArray(input.input.records, "records");
      if (records.length < 1 || records.length > 25) {
        throw new ProviderRequestError(400, "SmartSuite bulk record creation accepts 1 to 25 records");
      }
      return {
        records: requireArray(
          await request({
            path: `/applications/${encodeURIComponent(tableId)}/records/bulk/`,
            method: "POST",
            body: jsonObject({ items: records.map((record) => requireInputObject(record, "record")) }),
            maxResponseBytes: smartsuiteMetadataMaxResponseBytes,
          }),
          "created records",
        ),
      };
    }
    case "update_record": {
      requireReplicaWorkspace(workspaceId, "update_record");
      const { tableId, recordId } = readRecordIdentity(input.input);
      return {
        record: requireObject(
          await request({
            path: `/applications/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}/`,
            method: "PATCH",
            body: requireInputObject(input.input.fields, "fields"),
            maxResponseBytes: smartsuiteMetadataMaxResponseBytes,
          }),
          "updated record",
        ),
      };
    }
  }
}

async function hydrateAssignedToRecords(records: unknown[], request: SmartsuiteRequest): Promise<unknown[]> {
  const assignedIds = new Set<string>();
  for (const record of records) {
    const object = optionalRecord(record);
    if (!object) continue;
    for (const key of ["assigned_to", "Assigned To"]) {
      collectUnlabelledMemberIds(object[key], assignedIds);
    }
  }
  if (assignedIds.size === 0) return records;

  const payload = optionalRecord(
    await request({
      path: "/members/list/",
      method: "POST",
      query: { offset: "0", limit: "1000" },
      body: { sort: [], filter: {} },
    }),
  );
  if (!payload || !Array.isArray(payload.items)) {
    throw invalidPayload("member list response did not include items");
  }

  const labels = new Map<string, string>();
  for (const member of payload.items) {
    const object = optionalRecord(member);
    const id = readMemberId(object);
    const displayName = readMemberDisplayName(object);
    if (id && displayName) labels.set(id, displayName);
  }

  return records.map((record) => {
    const object = optionalRecord(record);
    if (!object) return record;
    const output = { ...object };
    let changed = false;
    for (const key of ["assigned_to", "Assigned To"]) {
      if (!(key in object)) continue;
      const hydrated = hydrateMemberValue(object[key], labels);
      if (hydrated !== object[key]) {
        output[key] = hydrated;
        changed = true;
      }
    }
    return changed ? output : record;
  });
}

function collectUnlabelledMemberIds(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectUnlabelledMemberIds(item, ids));
    return;
  }
  if (typeof value === "string" && value.trim()) {
    ids.add(value.trim());
    return;
  }
  const object = optionalRecord(value);
  if (!object) return;
  const id = readMemberId(object);
  if (id && !readMemberDisplayName(object)) ids.add(id);
}

function hydrateMemberValue(value: unknown, labels: Map<string, string>): unknown {
  if (Array.isArray(value)) {
    const hydrated = value.map((item) => hydrateMemberValue(item, labels));
    return hydrated.every((item, index) => item === value[index]) ? value : hydrated;
  }
  if (typeof value === "string" && value.trim()) {
    const id = value.trim();
    const displayName = labels.get(id);
    return displayName ? { id, displayName } : value;
  }
  const object = optionalRecord(value);
  if (!object) return value;
  const id = readMemberId(object);
  if (!id || readMemberDisplayName(object)) return value;
  const displayName = labels.get(id);
  return displayName ? { ...object, displayName } : value;
}

function readMemberId(value: Record<string, unknown> | undefined): string | undefined {
  if (!value) return undefined;
  return optionalString(value.id) ?? optionalString(value.user_id) ?? optionalString(value.userId);
}

function readMemberDisplayName(value: Record<string, unknown> | undefined): string | undefined {
  if (!value) return undefined;
  const fullName = optionalRecord(value.full_name);
  const nameParts = [optionalString(fullName?.first_name), optionalString(fullName?.last_name)].filter(Boolean);
  return (
    optionalString(value.displayName) ??
    optionalString(value.display_name) ??
    optionalString(value.name) ??
    optionalString(value.label) ??
    optionalString(fullName?.sys_root) ??
    (nameParts.length > 0 ? nameParts.join(" ") : undefined)
  );
}

async function requestSmartsuite(input: SmartsuiteRequestInput) {
  const url = new URL(`${smartsuiteApiBaseUrl}${input.path}`);
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (Array.isArray(value)) {
      url.searchParams.delete(key);
      for (const item of value) url.searchParams.append(key, String(item));
    } else if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  const timeout = createProviderTimeout(undefined, smartsuiteRequestTimeoutMs);
  try {
    const response = await input.fetcher(url, {
      method: input.method ?? "GET",
      headers: {
        accept: "application/json",
        authorization: `Token ${input.apiKey}`,
        "account-id": input.workspaceId,
        "content-type": "application/json",
        "user-agent": providerUserAgent,
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      signal: timeout.signal,
    });
    const payload = await readPayload(response, input.allowEmpty === true, input.maxResponseBytes);
    if (!response.ok) {
      throw createSmartsuiteError(response, payload, input.phase, input.apiKey, input.workspaceId);
    }
    return payload;
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      const secrets = [input.apiKey, input.workspaceId];
      throw new ProviderRequestError(
        error.status,
        redactSecrets(error.message, secrets),
        redactSecretValues(error.details, secrets),
      );
    }
    if (timeout.didTimeout() || (error instanceof DOMException && error.name === "AbortError")) {
      throw new ProviderRequestError(504, "SmartSuite request timed out");
    }
    throw new ProviderRequestError(
      502,
      error instanceof Error
        ? `SmartSuite request failed: ${redactSecrets(error.message, [input.apiKey, input.workspaceId])}`
        : "SmartSuite request failed",
    );
  } finally {
    timeout.cleanup();
  }
}

async function readPayload(response: Response, allowEmpty: boolean, maxResponseBytes?: number) {
  const text = await readProviderTextBody(
    response,
    "SmartSuite response",
    maxResponseBytes ?? smartsuiteMaxResponseBytes,
  );
  if (text.trim() === "") {
    if (allowEmpty || !response.ok) return null;
    throw invalidPayload("response did not include JSON");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (!response.ok) return null;
    throw invalidPayload("response was not valid JSON");
  }
}

function createSmartsuiteError(
  response: Response,
  payload: unknown,
  phase: "validate" | "execute",
  apiKey: string,
  workspaceId: string,
) {
  const record = optionalRecord(payload);
  const message = redactSecrets(
    optionalString(record?.message) ??
      optionalString(record?.detail) ??
      optionalString(record?.error) ??
      `SmartSuite request failed with status ${response.status}`,
    [apiKey, workspaceId],
  );
  if (response.status === 429) return new ProviderRequestError(429, message);
  if (response.status === 401 || response.status === 403) {
    return new ProviderRequestError(phase === "validate" ? 400 : 401, message);
  }
  if (400 <= response.status && response.status < 500) {
    return new ProviderRequestError(400, message);
  }
  return new ProviderRequestError(502, message);
}

function readWorkspaceId(input: Record<string, unknown> | undefined) {
  return readRequiredString(input?.workspaceId, "workspaceId");
}

function readRequiredString(value: unknown, field: string) {
  const result = optionalString(value);
  if (!result) throw new ProviderRequestError(400, `SmartSuite requires ${field}`);
  return result;
}

function readRecordIdentity(input: Record<string, unknown>) {
  return {
    tableId: readRequiredString(input.tableId, "tableId"),
    recordId: readRequiredString(input.recordId, "recordId"),
  };
}

function requireInputObject(value: unknown, field: string) {
  const object = optionalRecord(value);
  if (!object) throw new ProviderRequestError(400, `SmartSuite requires ${field} object`);
  return object;
}

function requireReplicaWorkspace(workspaceId: string, actionName: string): void {
  if (workspaceId !== smartsuiteReplicaWorkspaceId) {
    throw new ProviderRequestError(
      403,
      `SmartSuite ${actionName} is restricted to replica workspace ${smartsuiteReplicaWorkspaceId}`,
    );
  }
}

function requireObject(value: unknown, label: string) {
  const object = optionalRecord(value);
  if (!object) throw invalidPayload(`${label} response was not an object`);
  return object;
}

function requireArray(value: unknown, label: string) {
  if (!Array.isArray(value)) throw invalidPayload(`${label} response was not an array`);
  return value;
}

function readTableMetadataFields(table: Record<string, unknown>): Record<string, unknown>[] {
  for (const key of ["structure", "fields"]) {
    const value = table[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is Record<string, unknown> => optionalRecord(item) !== undefined);
    }
  }

  const fieldsMetadata = optionalRecord(table.fields_metadata);
  if (!fieldsMetadata) return [];

  return Object.entries(fieldsMetadata).flatMap(([slug, value]) => {
    const field = optionalRecord(value);
    if (!field) return [];
    return [{ ...field, slug: field.slug ?? slug }];
  });
}

function readRequiredInteger(value: unknown, field: string) {
  const integer = optionalInteger(value);
  if (integer === undefined) throw invalidPayload(`record list response did not include ${field}`);
  return integer;
}

function stringifyOptionalInteger(value: number | undefined) {
  return value === undefined ? undefined : String(value);
}

function stringifyOptionalBoolean(value: boolean | undefined) {
  return value === undefined ? undefined : String(value);
}

function readOptionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new ProviderRequestError(400, "SmartSuite fields must be a non-empty string array");
  }
  return value.map((item) => item.trim());
}

function invalidPayload(message: string) {
  return new ProviderRequestError(502, `SmartSuite ${message}`);
}

function redactSecrets(message: string, secrets: readonly string[]) {
  let redacted = message;
  for (const secret of secrets) {
    if (secret) {
      redacted = redacted.split(secret).join("[redacted]");
    }
  }
  return redacted;
}

function redactSecretValues(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactSecretValues(item, secrets));
  const record = optionalRecord(value);
  if (!record) return value;
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, redactSecretValues(item, secrets)]));
}
