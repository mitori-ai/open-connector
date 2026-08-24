import type {
  CredentialValidationResult,
  CredentialValidators,
  ProviderExecutors,
  ResolvedCredential,
} from "../../core/types.ts";
import type { OAuthProviderContext, ProviderFetch } from "../provider-runtime.ts";
import type { HelpscoutActionName } from "./actions.ts";

import {
  compactObject,
  optionalInteger,
  optionalRecord,
  optionalString,
  requiredRecord,
  requiredString,
} from "../../core/cast.ts";
import { readProviderJsonBody, ProviderRequestError, defineOAuthProviderExecutors } from "../provider-runtime.ts";
import { helpscoutActionHandlers as legacyHelpscoutActionHandlers } from "./runtime.ts";

const service = "helpscout";
const helpscoutApiBaseUrl = "https://api.helpscout.net/v2";
const helpscoutResponseMaxBytes = 10 * 1024 * 1024;
const helpscoutRequestTimeoutMs = 30_000;

type HelpscoutActionHandler = (input: Record<string, unknown>, context: OAuthProviderContext) => Promise<unknown>;

const transportHelpscoutActionHandlers: Record<
  Extract<HelpscoutActionName, "get_current_user" | "list_conversations" | "get_conversation" | "create_conversation" | "update_conversation" | "add_note" | "reply_to_conversation">,
  HelpscoutActionHandler
> = {
  get_current_user(_input, context) {
    return getCurrentUser(context);
  },
  list_conversations(input, context) {
    return listConversations(input, context);
  },
  get_conversation(input, context) {
    return getConversation(input, context);
  },
  create_conversation(input, context) {
    return createConversation(input, context);
  },
  update_conversation(input, context) {
    return updateConversation(input, context);
  },
  add_note(input, context) {
    return addNote(input, context);
  },
  reply_to_conversation(input, context) {
    return replyToConversation(input, context);
  },
};

export const helpscoutActionHandlers: Record<string, HelpscoutActionHandler> = {
  ...(legacyHelpscoutActionHandlers as Record<string, HelpscoutActionHandler>),
  ...transportHelpscoutActionHandlers,
};

export const executors: ProviderExecutors = defineOAuthProviderExecutors(service, helpscoutActionHandlers, {
  skipDnsValidation: true,
});

export const credentialValidators: CredentialValidators = {
  oauth2(input, { fetcher, signal }) {
    return validateHelpscoutCredential(input, fetcher, signal);
  },
};

export async function validateHelpscoutCredential(
  credential: Extract<ResolvedCredential, { authType: "oauth2" }>,
  fetcher: ProviderFetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const profile = await helpscoutRequestJson("/users/me", {
    accessToken: credential.accessToken,
    tokenType: credential.tokenType,
    fetcher,
    signal,
  });
  const userId = optionalInteger(profile.id);
  const companyId = optionalInteger(profile.companyId);
  const displayName =
    [optionalString(profile.firstName), optionalString(profile.lastName)].filter(Boolean).join(" ") ||
    optionalString(profile.email) ||
    (userId !== undefined ? `Help Scout user ${userId}` : "Help Scout user");

  return {
    profile: {
      accountId: userId !== undefined ? String(userId) : "helpscout:oauth2",
      displayName,
      grantedScopes: [],
    },
    grantedScopes: [],
    metadata: compactObject({
      apiBaseUrl: helpscoutApiBaseUrl,
      validationEndpoint: "/users/me",
      userId,
      companyId,
    }),
  };
}

async function getCurrentUser(context: OAuthProviderContext): Promise<Record<string, unknown>> {
  const profile = await helpscoutRequestJson("/users/me", context);
  return {
    profile: normalizeCurrentUser(profile),
  };
}

async function listConversations(
  input: Record<string, unknown>,
  context: OAuthProviderContext,
): Promise<Record<string, unknown>> {
  const query = new URLSearchParams();
  const queryFields: Array<[string, unknown]> = [
    ["page", input.page],
    ["embed", input.embed],
    ["mailbox", input.mailbox],
    ["folder", input.folder],
    ["status", input.status],
    ["tag", input.tag],
    ["assigned_to", input.assignedTo],
    ["modifiedSince", input.modifiedSince],
    ["number", input.number],
    ["sortField", input.sortField],
    ["sortOrder", input.sortOrder],
    ["query", input.query],
    ["customFieldsByIds", input.customFieldsByIds],
  ];
  for (const [key, value] of queryFields) {
    if (value !== undefined) {
      query.set(key, String(value));
    }
  }
  const payload = await helpscoutRequestJson(`/conversations?${query.toString()}`, context);
  const embedded = optionalRecord(payload._embedded) ?? {};
  const conversations = Array.isArray(embedded.conversations)
    ? embedded.conversations.map((item, index) => normalizeConversation(item, `conversations[${index}]`))
    : [];
  const pagePayload = requiredRecord(
    payload.page,
    "Help Scout page",
    (message) => new ProviderRequestError(502, message),
  );
  const pageNumber = optionalInteger(pagePayload.number);
  const pageSize = optionalInteger(pagePayload.size);
  const totalElements = optionalInteger(pagePayload.totalElements);
  const totalPages = optionalInteger(pagePayload.totalPages);
  if ([pageNumber, pageSize, totalElements, totalPages].some((value) => value === undefined)) {
    throw new ProviderRequestError(502, "Help Scout returned invalid conversation pagination.");
  }
  return {
    conversations,
    page: { number: pageNumber, size: pageSize, totalElements, totalPages },
  };
}

async function getConversation(
  input: Record<string, unknown>,
  context: OAuthProviderContext,
): Promise<Record<string, unknown>> {
  const id = requirePositiveInteger(input.conversationId, "conversationId");
  return getConversationById(id, input.embed, context);
}

async function createConversation(
  input: Record<string, unknown>,
  context: OAuthProviderContext,
): Promise<Record<string, unknown>> {
  const mailboxId = requirePositiveInteger(input.mailboxId, "mailboxId");
  const customer = readCustomer(input.customer);
  const subject = requiredString(input.subject, "subject", (message) => new ProviderRequestError(400, message));
  const body = requiredString(input.body, "body", (message) => new ProviderRequestError(400, message));
  const cc = readEmailList(input.cc, "cc");
  const tags = input.tags === undefined ? undefined : readTags(input.tags);
  const assignee = input.assignee === undefined ? undefined : requirePositiveInteger(input.assignee, "assignee");
  // Help Scout's documented create payload has no top-level cc field. Keep the
  // CC addresses on the initial customer thread and never emit conversations.cc.
  const payload = compactObject({
    subject,
    customer,
    mailboxId,
    type: "email",
    status: "active",
    threads: [compactObject({ type: "customer", customer, text: body, cc })],
    tags,
    assignTo: assignee,
  });
  const response = await helpscoutRequest("POST", "/conversations", context, payload);
  const responsePayload = await readOptionalProviderJsonBody(response);
  const id = readCreatedResourceId(response, responsePayload, "conversation");
  return getConversationById(id, undefined, context);
}

async function replyToConversation(
  input: Record<string, unknown>,
  context: OAuthProviderContext,
): Promise<Record<string, unknown>> {
  const conversationId = requirePositiveInteger(input.conversationId, "conversationId");
  const customer = readCustomer(input.customer);
  const body = requiredString(input.body, "body", (message) => new ProviderRequestError(400, message));
  const cc = readEmailList(input.cc, "cc");
  const assignee = input.assignee === undefined ? undefined : requirePositiveInteger(input.assignee, "assignee");
  const response = await helpscoutRequest(
    "POST",
    `/conversations/${conversationId}/reply`,
    context,
    compactObject({ customer, text: body, cc, assignTo: assignee }),
  );
  const responsePayload = await readOptionalProviderJsonBody(response);
  const threadId = readCreatedResourceId(response, responsePayload, "reply thread");
  const readBack = await getConversationById(conversationId, "threads", context);
  return { conversationId, threadId, ...readBack };
}

async function updateConversation(
  input: Record<string, unknown>,
  context: OAuthProviderContext,
): Promise<Record<string, unknown>> {
  const id = requirePositiveInteger(input.conversationId, "conversationId");
  let updated = false;
  if (input.subject !== undefined) {
    const subject = requiredString(input.subject, "subject", (message) => new ProviderRequestError(400, message));
    await helpscoutRequest("PATCH", `/conversations/${id}`, context, {
      op: "replace",
      path: "/subject",
      value: subject,
    });
    updated = true;
  }
  if (input.assignee !== undefined) {
    if (input.assignee === null) {
      await helpscoutRequest("PATCH", `/conversations/${id}`, context, {
        op: "remove",
        path: "/assignTo",
      });
    } else {
      await helpscoutRequest("PATCH", `/conversations/${id}`, context, {
        op: "replace",
        path: "/assignTo",
        value: requirePositiveInteger(input.assignee, "assignee"),
      });
    }
    updated = true;
  }
  if (input.tags !== undefined) {
    await helpscoutRequest("PUT", `/conversations/${id}/tags`, context, { tags: readTags(input.tags) });
    updated = true;
  }
  if (!updated) {
    throw new ProviderRequestError(400, "At least one of subject, assignee, or tags is required.");
  }
  return { conversationId: id, updated: true };
}

async function addNote(
  input: Record<string, unknown>,
  context: OAuthProviderContext,
): Promise<Record<string, unknown>> {
  const conversationId = requirePositiveInteger(input.conversationId, "conversationId");
  const text = requiredString(input.text, "text", (message) => new ProviderRequestError(400, message));
  const response = await helpscoutRequest("POST", `/conversations/${conversationId}/notes`, context, { text });
  const responsePayload = await readOptionalProviderJsonBody(response);
  const threadId = readCreatedResourceId(response, responsePayload, "note thread");
  return { conversationId, threadId, created: true };
}

async function getConversationById(
  id: number,
  embed: unknown,
  context: OAuthProviderContext,
): Promise<Record<string, unknown>> {
  const query = embed === undefined ? "" : `?embed=${encodeURIComponent(String(embed))}`;
  const payload = await helpscoutRequestJson(`/conversations/${id}${query}`, context);
  return { conversation: normalizeConversation(payload, "conversation") };
}

async function helpscoutRequestJson(path: string, context: OAuthProviderContext): Promise<Record<string, unknown>> {
  const response = await helpscoutRequest("GET", path, context);
  return requiredRecord(
    await readProviderJsonBody(response, {
      emptyBody: {},
      invalidJsonMessage: "Help Scout returned invalid JSON.",
      maxBytes: helpscoutResponseMaxBytes,
    }),
    "Help Scout response",
    (message) => new ProviderRequestError(502, message),
  );
}

async function readOptionalProviderJsonBody(response: Response): Promise<Record<string, unknown> | undefined> {
  const payload = await readProviderJsonBody(response, {
    emptyBody: undefined,
    invalidJsonMessage: "Help Scout returned invalid JSON.",
    maxBytes: helpscoutResponseMaxBytes,
  });
  if (payload === undefined) {
    return undefined;
  }
  return requiredRecord(payload, "Help Scout response", (message) => new ProviderRequestError(502, message));
}

async function helpscoutRequest(
  method: "GET" | "POST" | "PATCH" | "PUT",
  path: string,
  context: OAuthProviderContext,
  body?: Record<string, unknown>,
): Promise<Response> {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), helpscoutRequestTimeoutMs);
  const abortFromParent = (): void => timeoutController.abort();
  context.signal?.addEventListener("abort", abortFromParent, { once: true });
  try {
    const response = await context.fetcher(`${helpscoutApiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`, {
      method,
      headers: {
        accept: "application/json",
        authorization: `${context.tokenType ?? "Bearer"} ${context.accessToken}`,
        "user-agent": "oomol-connect/0.1",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: timeoutController.signal,
    });
    if (!response.ok) {
      let message = `Help Scout request failed with HTTP ${response.status}.`;
      try {
        const payload = await readProviderJsonBody(response, {
          emptyBody: {},
          invalidJsonMessage: "Help Scout request failed.",
          invalidJsonFallback: () => ({}),
          maxBytes: 256 * 1024,
        });
        const record = optionalRecord(payload);
        const embedded = optionalRecord(record?._embedded);
        const errors = Array.isArray(embedded?.errors) ? embedded.errors : [];
        const firstError = optionalRecord(errors[0]);
        const providerMessage = optionalString(record?.message) ?? optionalString(firstError?.message);
        if (providerMessage) {
          message = redactSecrets(providerMessage.slice(0, 1000), [context.accessToken]);
        }
      } catch {
        // Preserve the bounded status-only message when an error body cannot be read.
      }
      throw new ProviderRequestError(response.status, message);
    }
    return response;
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      throw error;
    }
    if (timeoutController.signal.aborted) {
      throw new ProviderRequestError(504, "Help Scout request timed out.");
    }
    throw new ProviderRequestError(502, "Help Scout request failed.");
  } finally {
    clearTimeout(timeoutId);
    context.signal?.removeEventListener("abort", abortFromParent);
  }
}

function normalizeCurrentUser(profile: Record<string, unknown>): Record<string, unknown> {
  const id = requirePositiveInteger(profile.id, "Help Scout user id");
  return compactObject({
    id,
    firstName: optionalString(profile.firstName) ?? null,
    lastName: optionalString(profile.lastName) ?? null,
    email: optionalString(profile.email) ?? null,
    role: optionalString(profile.role) ?? null,
    companyId: optionalInteger(profile.companyId) ?? null,
  });
}

function normalizeConversation(value: unknown, fieldName: string): Record<string, unknown> {
  const conversation = requiredRecord(value, fieldName, (message) => new ProviderRequestError(502, message));
  const id = requirePositiveInteger(conversation.id, `${fieldName}.id`);
  const assignee = optionalRecord(conversation.assignee);
  const createdBy = optionalRecord(conversation.createdBy);
  const primaryCustomer = optionalRecord(conversation.primaryCustomer);
  const source = optionalRecord(conversation.source);
  const tags = Array.isArray(conversation.tags) ? conversation.tags : [];
  const customFields = Array.isArray(conversation.customFields) ? conversation.customFields : [];
  const cc = Array.isArray(conversation.cc)
    ? conversation.cc.filter((item): item is string => typeof item === "string")
    : [];
  const bcc = Array.isArray(conversation.bcc)
    ? conversation.bcc.filter((item): item is string => typeof item === "string")
    : [];
  return compactObject({
    id,
    number: optionalInteger(conversation.number) ?? null,
    threads: optionalInteger(conversation.threads) ?? null,
    type: optionalString(conversation.type) ?? null,
    folderId: optionalInteger(conversation.folderId) ?? null,
    status: optionalString(conversation.status) ?? null,
    state: optionalString(conversation.state) ?? null,
    subject: optionalString(conversation.subject) ?? null,
    preview: optionalString(conversation.preview) ?? null,
    mailboxId: optionalInteger(conversation.mailboxId) ?? null,
    assignee: assignee ? normalizePerson(assignee) : null,
    createdBy: createdBy ? normalizePerson(createdBy) : null,
    createdAt: optionalString(conversation.createdAt) ?? null,
    closedBy: optionalInteger(conversation.closedBy) ?? null,
    closedAt: optionalString(conversation.closedAt) ?? null,
    userUpdatedAt: optionalString(conversation.userUpdatedAt) ?? null,
    source: source
      ? compactObject({ type: optionalString(source.type) ?? null, via: optionalString(source.via) ?? null })
      : null,
    tags: tags.map((tag, index) => normalizeLooseObject(tag, `tags[${index}]`)),
    cc,
    bcc,
    primaryCustomer: primaryCustomer ? normalizePerson(primaryCustomer) : null,
    customFields: customFields.map((item, index) => normalizeLooseObject(item, `customFields[${index}]`)),
    raw: sanitizeProviderRecord(conversation, 0),
  });
}

function normalizePerson(value: Record<string, unknown>): Record<string, unknown> {
  return compactObject({
    id: optionalInteger(value.id) ?? null,
    type: optionalString(value.type) ?? null,
    first: optionalString(value.first) ?? null,
    last: optionalString(value.last) ?? null,
    email: optionalString(value.email) ?? null,
  });
}

function normalizeLooseObject(value: unknown, fieldName: string): Record<string, unknown> {
  return sanitizeProviderRecord(
    requiredRecord(value, fieldName, (message) => new ProviderRequestError(502, message)),
    0,
  );
}

function readCustomer(value: unknown): Record<string, unknown> {
  const customer = requiredRecord(value, "customer", (message) => new ProviderRequestError(400, message));
  const id = customer.id === undefined ? undefined : requirePositiveInteger(customer.id, "customer.id");
  const email = customer.email === undefined ? undefined : requiredString(customer.email, "customer.email");
  if (id === undefined && email === undefined) {
    throw new ProviderRequestError(400, "customer.id or customer.email is required.");
  }
  return compactObject({
    id,
    email,
    firstName: optionalString(customer.firstName),
    lastName: optionalString(customer.lastName),
  });
}

function readEmailList(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new ProviderRequestError(400, `${fieldName} must contain between 1 and 100 email addresses.`);
  }
  const emails = value.map((item) =>
    requiredString(item, fieldName, (message) => new ProviderRequestError(400, message)),
  );
  if (new Set(emails.map((email) => email.toLowerCase())).size !== emails.length) {
    throw new ProviderRequestError(400, `${fieldName} must not contain duplicate email addresses.`);
  }
  return emails;
}

function readTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new ProviderRequestError(400, "tags must contain at most 100 tag names.");
  }
  const tags = value.map((item) => requiredString(item, "tags", (message) => new ProviderRequestError(400, message)));
  if (new Set(tags).size !== tags.length) {
    throw new ProviderRequestError(400, "tags must not contain duplicate tag names.");
  }
  return tags;
}

function readCreatedResourceId(
  response: Response,
  payload: Record<string, unknown> | undefined,
  resourceName: string,
): number {
  const id = readCreatedResourceIdentifier(response, payload);
  const parsed = id === undefined ? undefined : Number(id);
  if (parsed === undefined || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ProviderRequestError(502, `Help Scout did not return a valid created ${resourceName} ID.`);
  }
  return parsed;
}

function readCreatedResourceIdentifier(
  response: Response,
  payload: Record<string, unknown> | undefined,
): string | undefined {
  const payloadId = payload?.id ?? payload?.resourceId ?? payload?.["Resource-Id"];
  if (typeof payloadId === "number" && Number.isInteger(payloadId) && payloadId > 0) {
    return String(payloadId);
  }
  if (typeof payloadId === "string" && /^\d+$/.test(payloadId.trim())) {
    return payloadId.trim();
  }
  const headerId = response.headers.get("resource-id") ?? response.headers.get("x-resource-id");
  if (headerId && /^\d+$/.test(headerId.trim())) {
    return headerId.trim();
  }
  const location = response.headers.get("location");
  const match = location?.match(/\/(\d+)\/?(?:\?.*)?$/);
  return match?.[1];
}

function sanitizeProviderRecord(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  const sanitized = sanitizeProviderValue(value, depth);
  const record = optionalRecord(sanitized);
  if (!record) {
    throw new ProviderRequestError(502, "Help Scout returned an invalid object.");
  }
  return record;
}

function sanitizeProviderValue(value: unknown, depth: number): unknown {
  if (depth > 20) {
    throw new ProviderRequestError(502, "Help Scout response nesting is too deep.");
  }
  if (Array.isArray(value)) {
    if (value.length > 1000) {
      throw new ProviderRequestError(502, "Help Scout response array is too large.");
    }
    return value.map((item) => sanitizeProviderValue(item, depth + 1));
  }
  const object = optionalRecord(value);
  if (!object) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(object)) {
    if (isSensitiveKey(key)) {
      continue;
    }
    result[key] = sanitizeProviderValue(item, depth + 1);
  }
  return result;
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

function requirePositiveInteger(value: unknown, fieldName: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  throw new ProviderRequestError(400, `${fieldName} must be a positive integer.`);
}
