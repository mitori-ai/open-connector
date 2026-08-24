import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "helpscout" as const;

export const helpscoutConnectorScopes = {
  inboxRead: "helpscout.inbox.read",
  inboxWrite: "helpscout.inbox.write",
} as const;

const readScope = helpscoutConnectorScopes.inboxRead;
const writeScope = helpscoutConnectorScopes.inboxWrite;

const positiveId = (description: string) => s.positiveInteger(description);
const assignableUserId = (description: string) => s.integer(description, { exclusiveMinimum: 1 });
const rawProviderObject = (description: string) => s.looseObject(description);
const pageSchema = s.nullable(rawProviderObject("Help Scout pagination metadata, or null."));
const createConversationStatusSchema = s.stringEnum("The initial Help Scout conversation status.", [
  "active",
  "closed",
  "pending",
]);
const updateConversationStatusSchema = s.stringEnum("The Help Scout conversation status.", [
  "active",
  "closed",
  "open",
  "pending",
  "spam",
]);
const listConversationStatusSchema = s.stringEnum("The Help Scout conversation status filter.", [
  "active",
  "all",
  "closed",
  "open",
  "pending",
  "spam",
]);
const customFieldValuesSchema = s.array(
  "The complete set of custom fields to apply; omitted existing fields are removed.",
  s.object("One Help Scout custom field value.", {
    id: positiveId("The Help Scout custom field ID."),
    value: s.string("The field value; use an option ID for dropdown fields and YYYY-MM-DD for date fields.", {
      maxLength: 15_000,
    }),
  }),
);
const legacyMailboxFilter = s.string("A comma-separated list of Help Scout inbox IDs.", {
  pattern: "^\\d+(,\\d+)*$",
  minLength: 1,
  maxLength: 200,
});
const legacyTagFilter = s.string("A comma-separated list of Help Scout conversation tags.", {
  minLength: 1,
  maxLength: 500,
});
const legacyCustomFieldsFilter = s.string(
  "Help Scout custom field filters in the documented id:value,id:value format.",
  { minLength: 1, maxLength: 500 },
);
const currentUserSchema = s.object("The safe identity profile for the authenticated Help Scout user.", {
  id: positiveId("The authenticated Help Scout user ID."),
  firstName: s.nullableString("The authenticated user's first name."),
  lastName: s.nullableString("The authenticated user's last name."),
  email: s.nullableString("The authenticated user's email address."),
  role: s.nullableString("The authenticated user's Help Scout role."),
  companyId: s.nullableInteger("The Help Scout company ID."),
});

const transportConversationSchema = s.looseObject("A Help Scout Mailbox API conversation.");
const transportCustomerSchema: JsonSchema = {
  ...s.object(
    {
      id: s.positiveInteger("An existing Help Scout customer ID."),
      email: s.email("The customer's email address."),
      firstName: s.nonEmptyString("The customer's first name.", { maxLength: 40 }),
      lastName: s.nonEmptyString("The customer's last name.", { maxLength: 40 }),
    },
    {
      optional: ["id", "email", "firstName", "lastName"],
      description: "A Help Scout customer ID or email reference. If both are provided, Help Scout uses the ID.",
    },
  ),
  anyOf: [{ required: ["id"] }, { required: ["email"] }],
};
const transportEmailListSchema = (description: string) =>
  s.array(description, s.email("An email address."), { minItems: 1, maxItems: 100, uniqueItems: true });
const transportTagListSchema = s.array(
  "The complete desired Help Scout conversation tag list.",
  s.nonEmptyString("A tag name.", { maxLength: 200 }),
  { maxItems: 100, uniqueItems: true },
);

const customerIdentifierFields = {
  customerId: positiveId("The existing Help Scout customer ID."),
  customerEmail: s.email("The customer email address used to find or create the customer."),
  customerFirstName: s.nonEmptyString("The first name used when a new customer is created.", {
    maxLength: 40,
  }),
  customerLastName: s.nonEmptyString("The last name used when a new customer is created.", {
    maxLength: 40,
  }),
};

const pagedCollectionOutput = (name: string, fieldName: string) =>
  s.object(`One page of Help Scout ${name}.`, {
    [fieldName]: s.array(
      `The Help Scout ${name} returned on this page.`,
      rawProviderObject(`One object from the Help Scout ${name} collection.`),
    ),
    page: pageSchema,
  });

export const helpscoutActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "get_current_user",
    description: "Retrieve a safe identity profile for the authenticated Help Scout user.",
    requiredScopes: [readScope],
    inputSchema: s.object("No input is required.", {}),
    outputSchema: s.object("The authenticated Help Scout identity profile.", { profile: currentUserSchema }),
  }),
  defineProviderAction(service, {
    name: "list_inboxes",
    description: "List the Help Scout inboxes available to the connected user.",
    requiredScopes: [readScope],
    inputSchema: s.object(
      "Input parameters for listing Help Scout inboxes.",
      { page: s.positiveInteger("The 1-based result page to request.") },
      { optional: ["page"] },
    ),
    outputSchema: pagedCollectionOutput("inboxes", "inboxes"),
  }),
  defineProviderAction(service, {
    name: "list_inbox_folders",
    description: "List the folders and conversation counts in a Help Scout inbox.",
    requiredScopes: [readScope],
    inputSchema: s.object("Input parameters for listing Help Scout inbox folders.", {
      inboxId: positiveId("The Help Scout inbox ID."),
    }),
    outputSchema: pagedCollectionOutput("folders", "folders"),
  }),
  defineProviderAction(service, {
    name: "list_inbox_custom_fields",
    description: "List the custom field definitions and dropdown options for a Help Scout inbox.",
    requiredScopes: [readScope],
    inputSchema: s.object("Input parameters for listing Help Scout inbox custom fields.", {
      inboxId: positiveId("The Help Scout inbox ID."),
    }),
    outputSchema: pagedCollectionOutput("custom fields", "fields"),
  }),
  defineProviderAction(service, {
    name: "list_saved_replies",
    description: "List the approved saved reply templates available in a Help Scout inbox.",
    requiredScopes: [readScope],
    inputSchema: s.object(
      "Input parameters for listing Help Scout saved replies.",
      {
        inboxId: positiveId("The Help Scout inbox ID."),
        includeChatReplies: s.boolean("Whether chat-only saved replies should also be returned."),
      },
      { optional: ["includeChatReplies"] },
    ),
    outputSchema: s.object("The saved replies available in the Help Scout inbox.", {
      savedReplies: s.array(
        "The saved reply summaries returned by Help Scout.",
        rawProviderObject("One Help Scout saved reply summary."),
      ),
    }),
  }),
  defineProviderAction(service, {
    name: "get_saved_reply",
    description: "Get the complete email and chat content of a Help Scout saved reply.",
    requiredScopes: [readScope],
    inputSchema: s.object("Input parameters for getting a Help Scout saved reply.", {
      inboxId: positiveId("The Help Scout inbox ID containing the saved reply."),
      savedReplyId: positiveId("The Help Scout saved reply ID."),
    }),
    outputSchema: s.object("The requested Help Scout saved reply.", {
      savedReply: rawProviderObject("The Help Scout saved reply object."),
    }),
  }),
  defineProviderAction(service, {
    name: "list_users",
    description: "List Help Scout users, optionally filtered by email or inbox.",
    requiredScopes: [readScope],
    inputSchema: s.object(
      "Input parameters for listing Help Scout users.",
      {
        email: s.email("Return the Help Scout user with this exact email address."),
        inboxId: positiveId("Return users who have access to this Help Scout inbox."),
        page: s.positiveInteger("The 1-based result page to request."),
      },
      { optional: ["email", "inboxId", "page"] },
    ),
    outputSchema: pagedCollectionOutput("users", "users"),
  }),
  defineProviderAction(service, {
    name: "list_tags",
    description: "List tags used across the connected Help Scout account.",
    requiredScopes: [readScope],
    inputSchema: s.object(
      "Input parameters for listing Help Scout tags.",
      { page: s.positiveInteger("The 1-based result page to request.") },
      { optional: ["page"] },
    ),
    outputSchema: pagedCollectionOutput("tags", "tags"),
  }),
  defineProviderAction(service, {
    name: "list_workflows",
    description: "List Help Scout workflows, including the manual automations that can be run.",
    requiredScopes: [readScope],
    inputSchema: s.object(
      "Input parameters for listing Help Scout workflows.",
      {
        inboxId: positiveId("Return workflows associated with this Help Scout inbox."),
        type: s.stringEnum("The Help Scout workflow type.", ["automatic", "manual"]),
        page: s.positiveInteger("The 1-based result page to request."),
      },
      { optional: ["inboxId", "type", "page"] },
    ),
    outputSchema: pagedCollectionOutput("workflows", "workflows"),
  }),
  defineProviderAction(service, {
    name: "list_conversations",
    description: "List and filter conversations in the connected Help Scout account.",
    requiredScopes: [readScope],
    inputSchema: s.object(
      "Input parameters for listing Help Scout conversations.",
      {
        page: s.positiveInteger("The 1-based result page to request."),
        inboxIds: s.array(
          "The Help Scout inbox IDs whose conversations should be returned.",
          positiveId("One Help Scout inbox ID."),
          { minItems: 1 },
        ),
        folderId: positiveId("The Help Scout folder ID used to filter conversations."),
        status: listConversationStatusSchema,
        tagNames: s.stringArray("The tag names used to filter conversations.", {
          minItems: 1,
          itemDescription: "One Help Scout tag name.",
        }),
        assignedUserId: positiveId("The Help Scout user ID assigned to the conversations."),
        conversationNumber: positiveId("The human-facing Help Scout conversation number."),
        modifiedSince: s.dateTime("Return conversations modified after this ISO 8601 timestamp."),
        query: s.nonEmptyString("A Help Scout conversation search query."),
        sortField: s.stringEnum("The field used to sort conversations.", [
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
        sortOrder: s.stringEnum("The conversation sort direction.", ["asc", "desc"]),
        embedThreads: s.boolean("Whether to embed thread previews in each returned conversation."),
        embed: s.stringEnum("Embed the documented Help Scout sub-resource.", ["threads"]),
        mailbox: legacyMailboxFilter,
        folder: positiveId("The Help Scout folder ID used to filter conversations."),
        tag: legacyTagFilter,
        assignedTo: positiveId("The Help Scout user ID assigned to the conversations."),
        number: positiveId("The human-facing Help Scout conversation number."),
        customFieldsByIds: legacyCustomFieldsFilter,
      },
      {
        optional: [
          "page",
          "inboxIds",
          "folderId",
          "status",
          "tagNames",
          "assignedUserId",
          "conversationNumber",
          "modifiedSince",
          "query",
          "sortField",
          "sortOrder",
          "embedThreads",
          "embed",
          "mailbox",
          "folder",
          "tag",
          "assignedTo",
          "number",
          "customFieldsByIds",
        ],
      },
    ),
    outputSchema: pagedCollectionOutput("conversations", "conversations"),
  }),
  defineProviderAction(service, {
    name: "get_conversation",
    description: "Get one Help Scout conversation by ID.",
    requiredScopes: [readScope],
    inputSchema: s.object(
      "Input parameters for getting a Help Scout conversation.",
      {
        conversationId: positiveId("The Help Scout conversation ID."),
        embedThreads: s.boolean("Whether to embed thread previews in the conversation."),
        embed: s.stringEnum("Embed the documented Help Scout conversation sub-resource.", ["threads"]),
      },
      { optional: ["embedThreads", "embed"] },
    ),
    outputSchema: s.object("The requested Help Scout conversation.", {
      conversation: rawProviderObject("The Help Scout conversation object."),
    }),
  }),
  defineProviderAction(service, {
    name: "update_conversation",
    description:
      "Update only documented Help Scout conversation fields: subject, assignee, and the complete tag list. Arbitrary patches are not accepted.",
    requiredScopes: [writeScope],
    inputSchema: {
      ...s.object(
        "Input for a documented Help Scout conversation update. Provide at least one mutable field.",
        {
          conversationId: positiveId("The Help Scout conversation ID."),
          subject: s.nonEmptyString("The new Help Scout conversation subject.", { maxLength: 10_000 }),
          assignee: s.nullable(
            s.positiveInteger("The Help Scout user or team ID to assign; null removes the assignment."),
          ),
          tags: transportTagListSchema,
        },
        { optional: ["subject", "assignee", "tags"] },
      ),
      anyOf: [{ required: ["subject"] }, { required: ["assignee"] }, { required: ["tags"] }],
    },
    outputSchema: s.object("The Help Scout conversation update result.", {
      conversationId: positiveId("The Help Scout conversation ID updated."),
      updated: s.boolean("Whether Help Scout accepted the subject update."),
    }),
  }),
  defineProviderAction(service, {
    name: "list_threads",
    description: "List the complete threads belonging to a Help Scout conversation.",
    requiredScopes: [readScope],
    inputSchema: s.object(
      "Input parameters for listing conversation threads.",
      {
        conversationId: positiveId("The Help Scout conversation ID."),
        page: s.positiveInteger("The 1-based result page to request."),
      },
      { optional: ["page"] },
    ),
    outputSchema: pagedCollectionOutput("threads", "threads"),
  }),
  defineProviderAction(service, {
    name: "list_customers",
    description: "List and filter customers in the connected Help Scout account.",
    requiredScopes: [readScope],
    inputSchema: s.object(
      "Input parameters for listing Help Scout customers.",
      {
        page: s.positiveInteger("The 1-based result page to request."),
        inboxId: positiveId("Return customers associated with this Help Scout inbox."),
        firstName: s.nonEmptyString("Return customers with this first name."),
        lastName: s.nonEmptyString("Return customers with this last name."),
        email: s.email("Return customers matching this email address."),
        modifiedSince: s.dateTime("Return customers modified after this ISO 8601 timestamp."),
        sortField: s.stringEnum("The field used to sort customers.", [
          "createdAt",
          "firstName",
          "lastName",
          "modifiedAt",
        ]),
        sortOrder: s.stringEnum("The customer sort direction.", ["asc", "desc"]),
      },
      {
        optional: ["page", "inboxId", "firstName", "lastName", "email", "modifiedSince", "sortField", "sortOrder"],
      },
    ),
    outputSchema: pagedCollectionOutput("customers", "customers"),
  }),
  defineProviderAction(service, {
    name: "get_customer",
    description: "Get one Help Scout customer by ID.",
    requiredScopes: [readScope],
    inputSchema: s.object("Input parameters for getting a Help Scout customer.", {
      customerId: positiveId("The Help Scout customer ID."),
    }),
    outputSchema: s.object("The requested Help Scout customer.", {
      customer: rawProviderObject("The Help Scout customer object."),
    }),
  }),
  defineProviderAction(service, {
    name: "create_customer",
    description: "Create a Help Scout customer with a primary email address.",
    requiredScopes: [writeScope],
    inputSchema: s.object(
      "Input parameters for creating a Help Scout customer.",
      {
        email: s.email("The customer's primary email address."),
        emailType: s.optional(
          s.withDefault(
            s.stringEnum("The category assigned to the customer email address.", ["home", "other", "work"]),
            "work",
          ),
        ),
        firstName: s.nonEmptyString("The customer's first name.", { maxLength: 40 }),
        lastName: s.nonEmptyString("The customer's last name.", { maxLength: 40 }),
        phone: s.string("The customer's phone number."),
        jobTitle: s.string("The customer's job title.", { maxLength: 60 }),
        location: s.string("The customer's location.", { maxLength: 60 }),
        background: s.string("Internal background information about the customer.", {
          maxLength: 200,
        }),
        organizationId: positiveId("The Help Scout organization ID linked to the customer."),
      },
      {
        optional: [
          "emailType",
          "firstName",
          "lastName",
          "phone",
          "jobTitle",
          "location",
          "background",
          "organizationId",
        ],
      },
    ),
    outputSchema: s.object("The Help Scout customer creation result.", {
      created: s.boolean("Whether Help Scout accepted the customer creation."),
      customerId: s.nullableString("The created Help Scout customer ID, or null."),
      location: s.nullableString("The API location of the created customer, or null."),
    }),
  }),
  defineProviderAction(service, {
    name: "create_conversation",
    description:
      "Create an email conversation through the official Help Scout Mailbox API and return a GET read-back of the created conversation.",
    requiredScopes: [writeScope],
    inputSchema: s.object(
      "Input parameters for creating one Help Scout email conversation.",
      {
        mailboxId: positiveId("The Help Scout inbox where the conversation is created."),
        customer: transportCustomerSchema,
        subject: s.nonWhitespaceString("The conversation subject.", { maxLength: 10_000 }),
        body: s.nonWhitespaceString("The initial customer message text.", { maxLength: 500_000 }),
        cc: transportEmailListSchema(
          "Optional email addresses copied on the initial customer thread. Help Scout does not document a top-level create cc field.",
        ),
        tags: transportTagListSchema,
        assignee: positiveId("The Help Scout user or team ID to assign through the official assignTo field."),
      },
      { optional: ["cc", "tags", "assignee"], required: ["mailboxId", "customer", "subject", "body"] },
    ),
    outputSchema: s.object("The Help Scout conversation creation result.", {
      conversation: transportConversationSchema,
    }),
  }),
  defineProviderAction(service, {
    name: "reply_to_conversation",
    description:
      "Add a published reply thread through the official Help Scout Mailbox API with the customer recipient, optional CC list, and optional assignee.",
    requiredScopes: [writeScope],
    inputSchema: s.object(
      "Input parameters for adding one published Help Scout reply thread.",
      {
        conversationId: positiveId("The Help Scout conversation ID."),
        customer: transportCustomerSchema,
        body: s.nonWhitespaceString("The reply thread text.", { maxLength: 500_000 }),
        cc: transportEmailListSchema("Email addresses to CC on the reply thread."),
        assignee: positiveId("The Help Scout user or team ID to assign after publishing the reply."),
      },
      { optional: ["cc", "assignee"], required: ["conversationId", "customer", "body"] },
    ),
    outputSchema: s.object("The created reply thread and updated conversation.", {
      conversationId: positiveId("The Help Scout conversation ID."),
      threadId: positiveId("The created Help Scout reply thread ID."),
      conversation: transportConversationSchema,
    }),
  }),
  defineProviderAction(service, {
    name: "create_reply",
    description: "Add a published reply or draft reply to a Help Scout conversation.",
    requiredScopes: [writeScope],
    inputSchema: s.object(
      "Input parameters for replying to a Help Scout conversation.",
      {
        conversationId: positiveId("The Help Scout conversation ID."),
        customerId: positiveId("The Help Scout customer receiving the reply."),
        text: s.nonEmptyString("The HTML-supported reply text."),
        draft: s.boolean("Whether to save the reply as a draft instead of publishing it."),
        userId: positiveId("The Help Scout user adding the reply."),
        cc: s.array("The email addresses copied on the reply.", s.email("One CC email address.")),
        bcc: s.array("The email addresses blind-copied on the reply.", s.email("One BCC email address.")),
      },
      { optional: ["draft", "userId", "cc", "bcc"] },
    ),
    outputSchema: s.object("The Help Scout reply creation result.", {
      created: s.boolean("Whether Help Scout accepted the reply creation."),
      threadId: s.nullableString("The created Help Scout thread ID, or null."),
    }),
  }),
  defineProviderAction(service, {
    name: "create_note",
    description: "Add an internal note to a Help Scout conversation.",
    requiredScopes: [writeScope],
    inputSchema: s.object(
      "Input parameters for adding a Help Scout conversation note.",
      {
        conversationId: positiveId("The Help Scout conversation ID."),
        text: s.nonEmptyString("The HTML-supported internal note text."),
        userId: positiveId("The Help Scout user adding the note."),
      },
      { optional: ["userId"] },
    ),
    outputSchema: s.object("The Help Scout note creation result.", {
      created: s.boolean("Whether Help Scout accepted the note creation."),
      threadId: s.nullableString("The created Help Scout thread ID, or null."),
    }),
  }),
  defineProviderAction(service, {
    name: "add_note",
    description: "Add an internal note to an existing Help Scout conversation through the official notes endpoint.",
    requiredScopes: [writeScope],
    inputSchema: s.object("Input for adding one internal Help Scout note.", {
      conversationId: positiveId("The Help Scout conversation ID."),
      text: s.nonWhitespaceString("The internal note text.", { maxLength: 500_000 }),
    }),
    outputSchema: s.object("The result of adding an internal Help Scout note.", {
      conversationId: positiveId("The Help Scout conversation ID."),
      threadId: positiveId("The created Help Scout note thread ID."),
      created: s.boolean("Whether Help Scout accepted the note."),
    }),
  }),
  defineProviderAction(service, {
    name: "run_manual_workflow",
    description: "Run a configured Help Scout manual workflow on up to 50 conversations.",
    requiredScopes: [writeScope],
    inputSchema: s.object("Input parameters for running a Help Scout manual workflow.", {
      workflowId: positiveId("The Help Scout manual workflow ID."),
      conversationIds: s.array(
        "The conversations to which the workflow should be applied; all must be in its inbox.",
        positiveId("One Help Scout conversation ID."),
        { minItems: 1, maxItems: 50 },
      ),
    }),
    outputSchema: s.object("The Help Scout manual workflow execution result.", {
      executed: s.boolean("Whether Help Scout accepted the workflow execution."),
      workflowId: positiveId("The executed Help Scout workflow ID."),
      conversationIds: s.array(
        "The Help Scout conversations sent to the workflow.",
        positiveId("One Help Scout conversation ID."),
      ),
    }),
  }),
  defineProviderAction(service, {
    name: "replace_conversation_custom_fields",
    description: "Replace the complete custom field state of a Help Scout conversation.",
    requiredScopes: [writeScope],
    inputSchema: s.object("Input parameters for replacing conversation custom fields.", {
      conversationId: positiveId("The Help Scout conversation ID."),
      customFields: customFieldValuesSchema,
    }),
    outputSchema: s.object("The Help Scout custom field replacement result.", {
      updated: s.boolean("Whether Help Scout accepted the custom field replacement."),
      conversationId: positiveId("The updated Help Scout conversation ID."),
      customFields: customFieldValuesSchema,
    }),
  }),
  defineProviderAction(service, {
    name: "snooze_conversation",
    description: "Snooze a Help Scout conversation until a specific future time.",
    requiredScopes: [writeScope],
    inputSchema: s.object("Input parameters for snoozing a Help Scout conversation.", {
      conversationId: positiveId("The Help Scout conversation ID."),
      snoozedUntil: s.dateTime("The future ISO 8601 time when the conversation should return."),
      unsnoozeOnCustomerReply: s.boolean("Whether a new customer reply should immediately unsnooze the conversation."),
    }),
    outputSchema: s.object("The Help Scout conversation snooze result.", {
      updated: s.boolean("Whether Help Scout accepted the snooze setting."),
      conversationId: positiveId("The snoozed Help Scout conversation ID."),
      snoozedUntil: s.dateTime("The requested ISO 8601 time for the conversation to return."),
      unsnoozeOnCustomerReply: s.boolean("Whether a new customer reply will immediately unsnooze the conversation."),
    }),
  }),
  defineProviderAction(service, {
    name: "unsnooze_conversation",
    description: "Remove the snooze from a Help Scout conversation and return it to its queue.",
    requiredScopes: [writeScope],
    inputSchema: s.object("Input parameters for unsnoozing a Help Scout conversation.", {
      conversationId: positiveId("The Help Scout conversation ID."),
    }),
    outputSchema: s.object("The Help Scout conversation unsnooze result.", {
      updated: s.boolean("Whether Help Scout accepted the snooze removal."),
      conversationId: positiveId("The unsnoozed Help Scout conversation ID."),
    }),
  }),
  defineProviderAction(service, {
    name: "set_conversation_status",
    description: "Replace the status of a Help Scout conversation.",
    requiredScopes: [writeScope],
    inputSchema: s.object("Input parameters for replacing a conversation status.", {
      conversationId: positiveId("The Help Scout conversation ID."),
      status: updateConversationStatusSchema,
    }),
    outputSchema: s.object("The Help Scout conversation status update result.", {
      updated: s.boolean("Whether Help Scout accepted the status update."),
      conversationId: positiveId("The updated Help Scout conversation ID."),
      status: updateConversationStatusSchema,
    }),
  }),
  defineProviderAction(service, {
    name: "assign_conversation",
    description: "Assign a Help Scout conversation to a user or leave it unassigned.",
    requiredScopes: [writeScope],
    inputSchema: s.object("Input parameters for assigning a Help Scout conversation.", {
      conversationId: positiveId("The Help Scout conversation ID."),
      assignedUserId: s.nullable(positiveId("The Help Scout user ID, or null to leave the conversation unassigned.")),
    }),
    outputSchema: s.object("The Help Scout conversation assignment result.", {
      updated: s.boolean("Whether Help Scout accepted the assignment update."),
      conversationId: positiveId("The updated Help Scout conversation ID."),
      assignedUserId: s.nullable(positiveId("The assigned Help Scout user ID, or null when unassigned.")),
    }),
  }),
  defineProviderAction(service, {
    name: "replace_conversation_tags",
    description: "Replace the complete tag list on a Help Scout conversation.",
    requiredScopes: [writeScope],
    inputSchema: s.object("Input parameters for replacing conversation tags.", {
      conversationId: positiveId("The Help Scout conversation ID."),
      tagNames: s.stringArray(
        "The complete tag list to keep on the conversation; use an empty list to remove all tags.",
        { itemDescription: "One Help Scout tag name." },
      ),
    }),
    outputSchema: s.object("The Help Scout conversation tag replacement result.", {
      updated: s.boolean("Whether Help Scout accepted the tag replacement."),
      conversationId: positiveId("The updated Help Scout conversation ID."),
      tagNames: s.stringArray("The complete tag list sent to Help Scout.", {
        itemDescription: "One Help Scout tag name.",
      }),
    }),
  }),
] as const satisfies ActionDefinition[];

export type HelpscoutActionName = (typeof helpscoutActions)[number]["name"];

const helpscoutActionByName = new Map(helpscoutActions.map((action) => [action.name, action] as const));
