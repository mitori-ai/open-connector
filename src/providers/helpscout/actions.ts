import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "helpscout";

const conversationId = s.positiveInteger("The Help Scout conversation ID.");
const optionalPage = s.integer("The 1-based Help Scout conversation page number.", { minimum: 1, maximum: 100 });
const mailboxFilter = s.string({
  pattern: "^\\d+(,\\d+)*$",
  minLength: 1,
  maxLength: 200,
  description: "A comma-separated list of Help Scout mailbox IDs.",
});
const tagFilter = s.string({
  minLength: 1,
  maxLength: 500,
  description: "A comma-separated list of Help Scout conversation tags.",
});
const customFieldsFilter = s.string({
  minLength: 1,
  maxLength: 500,
  description: "Help Scout custom field filters in the documented id:value,id:value format.",
});
const rawObject = s.looseObject("The raw Help Scout object returned by the Mailbox API.");
const nullableString = (description: string) => s.nullableString(description);
const nullableInteger = (description: string) => s.nullableInteger(description);

const personSchema = s.looseObject("A Help Scout user or customer reference.", {
  id: nullableInteger("The Help Scout user or customer ID."),
  type: nullableString("The Help Scout entity type."),
  first: nullableString("The first name returned by Help Scout."),
  last: nullableString("The last name returned by Help Scout."),
  email: nullableString("The email address returned by Help Scout."),
});
const sourceSchema = s.looseObject("The originating Help Scout conversation source.", {
  type: nullableString("The source type."),
  via: nullableString("The source channel."),
});
const tagSchema = s.looseObject("A Help Scout conversation tag.", {
  id: nullableInteger("The tag ID."),
  color: nullableString("The deprecated tag color, when returned."),
  tag: nullableString("The tag name."),
});
const customFieldSchema = s.looseObject("A Help Scout conversation custom field.", {
  id: nullableInteger("The custom field ID."),
  name: nullableString("The custom field name."),
  value: nullableString("The custom field value."),
  text: nullableString("The custom field display text."),
});
const conversationSchema: JsonSchema = s.looseObject("A Help Scout Mailbox API conversation.", {
  id: conversationId,
  number: nullableInteger("The human-readable conversation number."),
  threads: nullableInteger("The number of published conversation threads."),
  type: nullableString("The conversation type, such as email, chat, or phone."),
  folderId: nullableInteger("The Help Scout folder ID."),
  status: nullableString("The conversation status."),
  state: nullableString("The conversation state."),
  subject: nullableString("The conversation subject."),
  preview: nullableString("Preview text from the most recent thread."),
  mailboxId: nullableInteger("The Help Scout mailbox ID."),
  assignee: s.nullable(personSchema),
  createdBy: s.nullable(personSchema),
  createdAt: nullableString("The UTC creation timestamp."),
  closedBy: nullableInteger("The ID of the user who closed the conversation."),
  closedAt: nullableString("The UTC close timestamp."),
  userUpdatedAt: nullableString("The UTC timestamp of the last user update."),
  source: s.nullable(sourceSchema),
  tags: s.array("Conversation tags returned by Help Scout.", tagSchema),
  cc: s.array("Email addresses copied on the conversation.", s.string("A copied email address.")),
  bcc: s.array("Email addresses blind-copied on the conversation.", s.string("A blind-copied email address.")),
  primaryCustomer: s.nullable(personSchema),
  customFields: s.array("Conversation custom field values.", customFieldSchema),
  raw: rawObject,
});

const paginationSchema = s.object("Help Scout conversation pagination metadata.", {
  number: s.integer("The zero-based page number returned by Help Scout."),
  size: s.integer("The page size returned by Help Scout."),
  totalElements: s.integer("The total number of matching conversations."),
  totalPages: s.integer("The total number of available pages."),
});

const listConversationsInputSchema = s.object(
  "Input parameters for the Help Scout Mailbox API List Conversations endpoint.",
  {
    page: optionalPage,
    embed: s.stringEnum("Embed the documented Help Scout sub-resource.", ["threads"]),
    mailbox: mailboxFilter,
    folder: s.positiveInteger("Filter conversations by a Help Scout folder ID."),
    status: s.stringEnum("Filter by Help Scout conversation status.", [
      "active",
      "all",
      "closed",
      "open",
      "pending",
      "spam",
    ]),
    tag: tagFilter,
    assignedTo: s.positiveInteger("Filter by the assigned Help Scout user ID."),
    modifiedSince: s.dateTime("Filter conversations modified after this UTC timestamp."),
    number: s.positiveInteger("Look up a conversation by its human-readable number."),
    sortField: s.stringEnum("Sort conversations by the documented Help Scout field.", [
      "createdAt",
      "customerEmail",
      "customerName",
      "mailboxid",
      "modifiedAt",
      "number",
      "score",
      "status",
      "subject",
      "waitingSince",
    ]),
    sortOrder: s.stringEnum("Sort order for the Help Scout conversation list.", ["desc", "asc"]),
    query: s.string({
      minLength: 1,
      maxLength: 1000,
      description: "The documented Help Scout advanced conversation query.",
    }),
    customFieldsByIds: customFieldsFilter,
  },
  {
    optional: [
      "page",
      "embed",
      "mailbox",
      "folder",
      "status",
      "tag",
      "assignedTo",
      "modifiedSince",
      "number",
      "sortField",
      "sortOrder",
      "query",
      "customFieldsByIds",
    ],
  },
);

const currentUserSchema = s.object("The safe identity profile for the authenticated Help Scout user.", {
  id: s.positiveInteger("The authenticated Help Scout user ID."),
  firstName: nullableString("The authenticated user's first name."),
  lastName: nullableString("The authenticated user's last name."),
  email: nullableString("The authenticated user's email address."),
  role: nullableString("The authenticated user's Help Scout role."),
  companyId: nullableInteger("The Help Scout company ID."),
});

export type HelpscoutActionName =
  | "get_current_user"
  | "list_conversations"
  | "get_conversation"
  | "update_conversation";

export const helpscoutActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "get_current_user",
    description: "Retrieve a safe identity profile for the authenticated Help Scout Mailbox API user.",
    inputSchema: s.actionInput({}, [], "No input is required."),
    outputSchema: s.actionOutput({ profile: currentUserSchema }, "The authenticated Help Scout identity profile."),
  }),
  defineProviderAction(service, {
    name: "list_conversations",
    description: "List Help Scout Mailbox API conversations with documented filters and bounded page pagination.",
    inputSchema: listConversationsInputSchema,
    outputSchema: s.actionOutput(
      {
        conversations: s.array("The Help Scout conversations returned by this page.", conversationSchema),
        page: paginationSchema,
      },
      "A bounded Help Scout conversation page.",
    ),
  }),
  defineProviderAction(service, {
    name: "get_conversation",
    description: "Retrieve one Help Scout Mailbox API conversation by ID, optionally embedding its threads.",
    inputSchema: s.actionInput(
      {
        conversationId,
        embed: s.stringEnum("Embed the documented Help Scout conversation sub-resource.", ["threads"]),
      },
      ["conversationId"],
      "Input parameters for retrieving a Help Scout conversation.",
    ),
    outputSchema: s.actionOutput({ conversation: conversationSchema }, "The requested Help Scout conversation."),
  }),
  defineProviderAction(service, {
    name: "update_conversation",
    description:
      "Replace only the Help Scout conversation subject. This action sends the official JSON Patch replace /subject operation and does not accept arbitrary patches.",
    inputSchema: s.actionInput(
      {
        conversationId,
        subject: s.string({
          minLength: 1,
          maxLength: 10000,
          description: "The new Help Scout conversation subject.",
        }),
      },
      ["conversationId", "subject"],
      "Input for the reviewed subject-only Help Scout conversation update.",
    ),
    outputSchema: s.actionOutput(
      {
        conversationId: s.positiveInteger("The Help Scout conversation ID updated."),
        updated: s.boolean("Whether Help Scout accepted the subject update."),
      },
      "The result of the official Help Scout subject update.",
    ),
  }),
];
