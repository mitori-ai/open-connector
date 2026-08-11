import type { CredentialValidationResult } from "../../core/types.ts";
import type { ApiKeyProviderContext, ProviderFetch, ProviderRuntimeHandler } from "../provider-runtime.ts";

import { optionalBoolean, optionalInteger, optionalRecord, optionalString } from "../../core/cast.ts";
import {
  createProviderTimeout,
  isAbortLikeError,
  ProviderRequestError,
  providerUserAgent,
  readProviderTextBody,
} from "../provider-runtime.ts";

export interface SmartSuiteContext extends Pick<ApiKeyProviderContext, "apiKey" | "fetcher" | "signal"> {
  workspaceId: string;
}

type SmartSuitePhase = "validate" | "execute";
type SmartSuiteMethod = "GET" | "POST" | "PATCH";
type SmartSuiteQueryValue = string | number | boolean | undefined;

interface SmartSuiteRequestInput {
  apiKey: string;
  workspaceId: string;
  fetcher: ProviderFetch;
  path: string;
  method?: SmartSuiteMethod;
  query?: Record<string, SmartSuiteQueryValue>;
  body?: unknown;
  phase: SmartSuitePhase;
  signal?: AbortSignal;
}

export const smartsuiteApiBaseUrl = "https://app.smartsuite.com/api/v1";
const smartsuiteApiRequestBaseUrl = `${smartsuiteApiBaseUrl}/`;
const smartsuiteValidationPath = "/solutions/";
const smartsuiteRequestTimeoutMs = 30_000;
const smartsuiteMaxResponseBytes = 10 * 1024 * 1024;
const smartsuiteMaxRequestBytes = 1 * 1024 * 1024;
const maxRecordsPerResponse = 1000;
const maxSorts = 20;
const maxFilters = 100;
const maxUpdateFields = 100;

const systemFieldNames = new Set([
  "autonumber",
  "count",
  "firstcreated",
  "formula",
  "lastupdated",
  "recordid",
  "rollup",
  "vote",
]);

export const smartsuiteActionHandlers: Record<string, ProviderRuntimeHandler<SmartSuiteContext>> = {
  async list_records(input, context) {
    return listRecords(input, context);
  },
  async search_records(input, context) {
    return listRecords(input, context);
  },
  async get_record(input, context) {
    const tableId = readIdentifier(input.tableId, "tableId");
    const recordId = readIdentifier(input.recordId, "recordId");
    const payload = await smartsuiteRequest({
      ...context,
      path: `/applications/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}/`,
      query: { hydrated: readOptionalBoolean(input.hydrated) },
      phase: "execute",
    });
    return { record: normalizeRecord(payload, "SmartSuite record response") };
  },
  async update_record(input, context) {
    const tableId = readIdentifier(input.tableId, "tableId");
    const recordId = readIdentifier(input.recordId, "recordId");
    const fields = readUpdateFields(input.fields);
    const payload = await smartsuiteRequest({
      ...context,
      path: `/applications/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}/`,
      method: "PATCH",
      body: fields,
      phase: "execute",
    });
    return { record: normalizeRecord(payload, "SmartSuite update response") };
  },
};

export async function validateSmartSuiteCredential(
  input: { apiKey: string; values: Record<string, string> },
  fetcher: ProviderFetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const apiKey = readApiKey(input.apiKey);
  const workspaceId = readWorkspaceId(input.values);
  await smartsuiteRequest({
    apiKey,
    workspaceId,
    fetcher,
    signal,
    path: smartsuiteValidationPath,
    phase: "validate",
  });

  return {
    profile: {
      accountId: workspaceId,
      displayName: `SmartSuite workspace ${workspaceId}`,
    },
    grantedScopes: [],
    metadata: {
      apiBaseUrl: smartsuiteApiBaseUrl,
      validationEndpoint: smartsuiteValidationPath,
      workspaceId,
    },
  };
}

async function listRecords(
  input: Record<string, unknown>,
  context: SmartSuiteContext,
): Promise<Record<string, unknown>> {
  const tableId = readIdentifier(input.tableId, "tableId");
  const body: Record<string, unknown> = {
    sort: readSorts(input.sort),
    filter: readOptionalFilter(input.filter),
  };
  const hydrated = readOptionalBoolean(input.hydrated);
  if (hydrated !== undefined) {
    body.hydrated = hydrated;
  }

  const limit = readOptionalLimit(input.limit) ?? 100;
  const payload = await smartsuiteRequest({
    ...context,
    path: `/applications/${encodeURIComponent(tableId)}/records/list/`,
    method: "POST",
    query: {
      offset: readOptionalOffset(input.offset),
      limit,
      all: readOptionalBoolean(input.all),
    },
    body,
    phase: "execute",
  });
  return normalizeRecordList(payload);
}

async function smartsuiteRequest(input: SmartSuiteRequestInput): Promise<unknown> {
  const url = buildSmartSuiteUrl(input.path, input.query);
  const timeout = createProviderTimeout(input.signal, smartsuiteRequestTimeoutMs);
  try {
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    if (body !== undefined && body.length > smartsuiteMaxRequestBytes) {
      throw new ProviderRequestError(413, "SmartSuite request body is too large");
    }
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Token ${input.apiKey}`,
      "account-id": input.workspaceId,
      "user-agent": providerUserAgent,
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }

    const response = await input.fetcher(url, {
      method: input.method ?? "GET",
      headers,
      body,
      signal: timeout.signal,
    });
    const payload = await readSmartSuitePayload(response, input.phase, input.apiKey, input.workspaceId);
    if (!response.ok) {
      throw createSmartSuiteError(response.status, payload, input.phase, input.apiKey, input.workspaceId);
    }
    return payload;
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      throw error;
    }
    if (timeout.didTimeout() || isAbortLikeError(error)) {
      throw new ProviderRequestError(504, "SmartSuite request timed out");
    }
    const message = error instanceof Error ? error.message : "SmartSuite request failed";
    throw new ProviderRequestError(502, redactSecrets(message, [input.apiKey, input.workspaceId]));
  } finally {
    timeout.cleanup();
  }
}

function buildSmartSuiteUrl(path: string, query?: Record<string, SmartSuiteQueryValue>): URL {
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const url = new URL(normalizedPath, smartsuiteApiRequestBaseUrl);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function readSmartSuitePayload(
  response: Response,
  phase: SmartSuitePhase,
  apiKey: string,
  workspaceId: string,
): Promise<unknown> {
  const text = await readProviderTextBody(response, "SmartSuite response", smartsuiteMaxResponseBytes);
  if (!text.trim()) {
    if (response.ok) {
      throw new ProviderRequestError(502, "SmartSuite returned an empty response");
    }
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (!response.ok) {
      throw createSmartSuiteError(response.status, undefined, phase, apiKey, workspaceId, text);
    }
    throw new ProviderRequestError(502, "SmartSuite returned invalid JSON");
  }
}

function createSmartSuiteError(
  status: number,
  payload: unknown,
  phase: SmartSuitePhase,
  apiKey: string,
  workspaceId: string,
  fallback?: string,
): ProviderRequestError {
  const message = redactSecrets(extractErrorMessage(payload) ?? fallback ?? "SmartSuite request failed", [
    apiKey,
    workspaceId,
  ]);
  if (phase === "validate" && (status === 401 || status === 403)) {
    return new ProviderRequestError(400, "SmartSuite credentials were rejected");
  }
  if (status === 401 || status === 403) {
    return new ProviderRequestError(401, message);
  }
  if (status >= 400 && status < 500) {
    return new ProviderRequestError(400, message);
  }
  return new ProviderRequestError(502, message);
}

function extractErrorMessage(payload: unknown): string | undefined {
  const record = optionalRecord(payload);
  if (!record) {
    return undefined;
  }
  const error = optionalRecord(record.error);
  return optionalString(record.message) ?? optionalString(record.detail) ?? optionalString(error?.message);
}

function normalizeRecordList(payload: unknown): Record<string, unknown> {
  const object = requireObject(payload, "SmartSuite record list response");
  const items = object.items;
  if (!Array.isArray(items)) {
    throw new ProviderRequestError(502, "SmartSuite record list response is missing items");
  }
  if (items.length > maxRecordsPerResponse) {
    throw new ProviderRequestError(502, "SmartSuite returned too many records");
  }
  return {
    records: items.map((item) => normalizeRecord(item, "SmartSuite record list item")),
    total: readNullableInteger(object.total),
    offset: readNullableInteger(object.offset),
    limit: readNullableInteger(object.limit),
  };
}

function normalizeRecord(payload: unknown, label: string): Record<string, unknown> {
  const record = requireObject(payload, label);
  return sanitizeRecord(record, 0);
}

function sanitizeRecord(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  if (depth > 20) {
    throw new ProviderRequestError(502, "SmartSuite record nesting is too deep");
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      continue;
    }
    output[key] = sanitizeValue(item, depth + 1);
  }
  return output;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1000) {
      throw new ProviderRequestError(502, "SmartSuite record array is too large");
    }
    return value.map((item) => sanitizeValue(item, depth));
  }
  const object = optionalRecord(value);
  return object ? sanitizeRecord(object, depth) : value;
}

function readSorts(value: unknown): Array<Record<string, string>> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > maxSorts) {
    throw new ProviderRequestError(400, "sort must contain at most 20 directives");
  }
  return value.map((item) => {
    const object = requireObject(item, "sort directive");
    return {
      field: readIdentifier(object.field, "sort.field"),
      direction: readEnum(object.direction, ["asc", "desc"], "sort.direction"),
    };
  });
}

function readOptionalFilter(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  const object = requireObject(value, "filter");
  const fields = object.fields;
  if (!Array.isArray(fields) || fields.length > maxFilters) {
    throw new ProviderRequestError(400, "filter.fields must contain at most 100 fields");
  }
  const operator = readEnum(object.operator, ["and", "or"], "filter.operator");
  return {
    operator,
    fields: fields.map((item) => {
      const field = requireObject(item, "filter field");
      return {
        field: readIdentifier(field.field, "filter field.field"),
        comparison: readComparison(field.comparison),
        value: field.value,
      };
    }),
  };
}

function readComparison(value: unknown): string {
  const comparisons = [
    "is",
    "is_not",
    "is_empty",
    "is_not_empty",
    "contains",
    "not_contains",
    "is_equal_to",
    "is_not_equal_to",
    "is_greater_than",
    "is_less_than",
    "is_equal_or_greater_than",
    "is_equal_or_less_than",
    "is_any_of",
    "is_none_of",
    "has_any_of",
    "has_all_of",
    "is_exactly",
    "has_none_of",
    "is_before",
    "is_on_or_before",
    "is_on_or_after",
    "is_overdue",
    "is_not_overdue",
    "file_name_contains",
    "file_type_is",
  ];
  return readEnum(value, comparisons, "filter.comparison");
}

function readUpdateFields(value: unknown): Record<string, unknown> {
  const fields = requireObject(value, "fields");
  const entries = Object.entries(fields);
  if (entries.length === 0) {
    throw new ProviderRequestError(400, "fields must contain at least one mutable record field");
  }
  if (entries.length > maxUpdateFields) {
    throw new ProviderRequestError(400, "fields must contain at most 100 record fields");
  }
  for (const [key, fieldValue] of entries) {
    const normalized = key.toLowerCase().replace(/[\s_-]/g, "");
    if (systemFieldNames.has(normalized)) {
      throw new ProviderRequestError(400, `fields contains a SmartSuite system-generated field: ${key}`);
    }
    if (fieldValue === undefined) {
      throw new ProviderRequestError(400, `fields.${key} cannot be undefined`);
    }
  }
  return fields;
}

function readApiKey(value: unknown): string {
  const apiKey = optionalString(value);
  if (!apiKey) {
    throw new ProviderRequestError(400, "apiKey is required");
  }
  return apiKey;
}

function readWorkspaceId(values: Record<string, string>): string {
  const workspaceId = optionalString(values.workspaceId);
  if (!workspaceId) {
    throw new ProviderRequestError(400, "workspaceId is required");
  }
  return workspaceId;
}

function readIdentifier(value: unknown, fieldName: string): string {
  const identifier = optionalString(value);
  if (!identifier || identifier.length > 200 || /[/?#]/.test(identifier)) {
    throw new ProviderRequestError(400, `${fieldName} must be a non-empty path-safe identifier`);
  }
  return identifier;
}

function readOptionalOffset(value: unknown): number | undefined {
  const offset = optionalInteger(value);
  if (value !== undefined && (offset === undefined || offset < 0 || offset > 1_000_000)) {
    throw new ProviderRequestError(400, "offset must be an integer between 0 and 1000000");
  }
  return offset;
}

function readOptionalLimit(value: unknown): number | undefined {
  const limit = optionalInteger(value);
  if (value !== undefined && (limit === undefined || limit < 1 || limit > 1000)) {
    throw new ProviderRequestError(400, "limit must be an integer between 1 and 1000");
  }
  return limit;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const result = optionalBoolean(value);
  if (result === undefined) {
    throw new ProviderRequestError(400, "boolean input must be true or false");
  }
  return result;
}

function readNullableInteger(value: unknown): number | null {
  return optionalInteger(value) ?? null;
}

function readEnum<T extends string>(value: unknown, values: readonly T[], fieldName: string): T {
  if (typeof value === "string" && values.includes(value as T)) {
    return value as T;
  }
  throw new ProviderRequestError(400, `${fieldName} is invalid`);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  const object = optionalRecord(value);
  if (!object) {
    throw new ProviderRequestError(502, `${label} must be an object`);
  }
  return object;
}

function isSensitiveKey(key: string): boolean {
  return /^(api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|token|secret|password|client[_-]?secret)$/i.test(
    key.trim(),
  );
}

function redactSecrets(message: string, secrets: string[]): string {
  let result = message;
  for (const secret of secrets) {
    if (secret) {
      result = result.split(secret).join("[redacted]");
    }
  }
  return result;
}

export const smartsuiteInternals: {
  buildSmartSuiteUrl: typeof buildSmartSuiteUrl;
  readUpdateFields: typeof readUpdateFields;
  normalizeRecordList: typeof normalizeRecordList;
} = {
  buildSmartSuiteUrl,
  readUpdateFields,
  normalizeRecordList,
};
