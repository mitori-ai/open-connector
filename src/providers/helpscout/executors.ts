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

const service = "helpscout";
const helpscoutApiBaseUrl = "https://api.helpscout.net/v2";
const helpscoutResponseMaxBytes = 10 * 1024 * 1024;
const helpscoutRequestTimeoutMs = 30_000;

type HelpscoutActionHandler = (input: Record<string, unknown>, context: OAuthProviderContext) => Promise<unknown>;

export const helpscoutActionHandlers: Record<HelpscoutActionName, HelpscoutActionHandler> = {
  get_current_user(_input, context) {
    return getCurrentUser(context);
  },
  list_conversations(input, context) {
    return listConversations(input, context);
  },
  get_conversation(input, context) {
    return getConversation(input, context);
  },
  update_conversation(input, context) {
    return updateConversation(input, context);
  },
};

export const executors: ProviderExecutors = defineOAuthProviderExecutors(service, helpscoutActionHandlers);

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
  const embed = input.embed === undefined ? "" : `?embed=${encodeURIComponent(String(input.embed))}`;
  const payload = await helpscoutRequestJson(`/conversations/${id}${embed}`, context);
  return {
    conversation: normalizeConversation(payload, "conversation"),
  };
}

async function updateConversation(
  input: Record<string, unknown>,
  context: OAuthProviderContext,
): Promise<Record<string, unknown>> {
  const id = requirePositiveInteger(input.conversationId, "conversationId");
  const subject = requiredString(input.subject, "subject", (message) => new ProviderRequestError(400, message));
  await helpscoutRequest("PATCH", `/conversations/${id}`, context, {
    op: "replace",
    path: "/subject",
    value: subject,
  });
  return { conversationId: id, updated: true };
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

async function helpscoutRequest(
  method: "GET" | "PATCH",
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
          message = providerMessage.slice(0, 1000);
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
    raw: conversation,
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
  return requiredRecord(value, fieldName, (message) => new ProviderRequestError(502, message));
}

function requirePositiveInteger(value: unknown, fieldName: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  throw new ProviderRequestError(400, `${fieldName} must be a positive integer.`);
}
