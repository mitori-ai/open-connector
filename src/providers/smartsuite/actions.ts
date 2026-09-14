import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "smartsuite";

const idSchema = (description: string) => s.nonWhitespaceString(description);
const dynamicObjectSchema = (description: string) => s.looseObject(description);
const dynamicRecordSchema = dynamicObjectSchema(
  "A SmartSuite record whose properties are determined by the Table field slugs.",
);
const solutionSchema = s.looseObject("A SmartSuite Solution returned by the API.", {
  id: idSchema("The Solution ID."),
  name: s.string("The Solution name."),
});
const tableSchema = s.looseObject("A SmartSuite Table returned by the API.", {
  id: idSchema("The Table ID."),
  name: s.string("The Table name."),
  solution: idSchema("The ID of the Solution containing the Table."),
});
const tableMetadataSchema = s.looseObject("A SmartSuite Table metadata object returned by the detail endpoint.", {
  id: s.optional(idSchema("The Table ID.")),
  name: s.optional(s.string("The Table name.")),
  solution: s.optional(idSchema("The ID of the Solution containing the Table.")),
});
const tableMetadataFieldSchema = s.looseObject("A SmartSuite field metadata object.", {
  id: s.optional(idSchema("The SmartSuite field ID, when returned.")),
  slug: s.optional(s.string("The SmartSuite field slug, when returned.")),
  label: s.optional(s.string("The SmartSuite field label, when returned.")),
  field_type: s.optional(s.string("The SmartSuite field type, when returned.")),
  params: s.optional(s.looseObject("SmartSuite field parameters, including choices and linked-field metadata.")),
});
const viewSchema = s.looseObject(
  "A saved SmartSuite View/report, including its state, returned by the reports collection.",
);
const folderSchema = s.looseObject("A SmartSuite View folder returned by the folders collection.");
const widgetSchema = s.looseObject("A SmartSuite Dashboard widget definition.");

const emptyInputSchema = s.object("No input is required.", {});
const recordIdentityInputFields = {
  tableId: idSchema("The SmartSuite Table ID."),
  recordId: idSchema("The SmartSuite record ID."),
};

export const smartsuiteActions: readonly ActionDefinition[] = [
  defineProviderAction(service, {
    name: "list_solutions",
    description: "List the Solutions accessible in the connected SmartSuite workspace.",
    requiredScopes: [],
    inputSchema: emptyInputSchema,
    outputSchema: s.object("The accessible SmartSuite Solutions.", {
      solutions: s.array("The accessible Solutions.", solutionSchema),
    }),
  }),
  defineProviderAction(service, {
    name: "list_tables",
    description: "List SmartSuite Tables, optionally limited to one Solution.",
    requiredScopes: [],
    inputSchema: s.object(
      "Filters the SmartSuite Tables to list.",
      {
        solutionId: idSchema("The Solution ID used to limit the returned Tables."),
      },
      { optional: ["solutionId"] },
    ),
    outputSchema: s.object("The accessible SmartSuite Tables.", {
      tables: s.array("The accessible Tables.", tableSchema),
    }),
  }),
  defineProviderAction(service, {
    name: "get_table_metadata",
    description:
      "Get one SmartSuite Table's read-only metadata, including fields, select options, hidden flags, and linked-field metadata.",
    requiredScopes: [],
    inputSchema: s.requiredObject("The input payload for reading SmartSuite Table metadata.", {
      tableId: idSchema("The SmartSuite Table ID."),
    }),
    outputSchema: s.requiredObject("The SmartSuite Table metadata response.", {
      table: tableMetadataSchema,
      fields: s.array("Normalized field metadata extracted from the Table structure.", tableMetadataFieldSchema),
    }),
    followUpActions: ["smartsuite.list_records"],
  }),
  defineProviderAction(service, {
    name: "list_views",
    description:
      "List saved SmartSuite Views for one Table, including displayed fields, filters, sorts, groups, calendar settings, and dashboard state. Read-only.",
    requiredScopes: [],
    inputSchema: s.requiredObject("The input payload for listing saved SmartSuite Views.", {
      tableId: idSchema("The SmartSuite Table ID whose Views should be listed."),
    }),
    outputSchema: s.requiredObject("The saved SmartSuite Views for the Table.", {
      views: s.array("Saved SmartSuite Views/reports.", viewSchema),
    }),
  }),
  defineProviderAction(service, {
    name: "get_view",
    description: "Get one saved SmartSuite View/report with its complete read-only state.",
    requiredScopes: [],
    inputSchema: s.requiredObject("The input payload for reading one saved SmartSuite View.", {
      viewId: idSchema("The SmartSuite View ID."),
    }),
    outputSchema: s.requiredObject("The saved SmartSuite View/report.", {
      view: viewSchema,
    }),
  }),
  defineProviderAction(service, {
    name: "list_dashboard_widgets",
    description: "List SmartSuite Dashboard widgets for one saved View and optional tab. Read-only.",
    requiredScopes: [],
    inputSchema: s.object(
      "The input payload for listing Dashboard widgets.",
      {
        reportId: idSchema("The SmartSuite Dashboard View ID."),
        tabId: idSchema("Optional SmartSuite Dashboard tab ID."),
      },
      { optional: ["tabId"] },
    ),
    outputSchema: s.requiredObject("The Dashboard widgets for the View.", {
      widgets: s.array("SmartSuite Dashboard widgets.", widgetSchema),
    }),
  }),
  defineProviderAction(service, {
    name: "list_folders",
    description: "List SmartSuite View folders for one Table. Read-only.",
    requiredScopes: [],
    inputSchema: s.requiredObject("The input payload for listing SmartSuite View folders.", {
      tableId: idSchema("The SmartSuite Table ID whose folders should be listed."),
    }),
    outputSchema: s.requiredObject("The SmartSuite View folders for the Table.", {
      folders: s.array("SmartSuite View folders.", folderSchema),
    }),
  }),
  defineProviderAction(service, {
    name: "list_records",
    description: "List records in a SmartSuite Table with optional pagination, sorting, and filtering.",
    requiredScopes: [],
    inputSchema: s.object(
      "Selects and filters records in a SmartSuite Table.",
      {
        tableId: idSchema("The SmartSuite Table ID."),
        offset: s.nonNegativeInteger("The number of matching records to skip."),
        limit: s.integer("The maximum number of records to return.", { minimum: 1, maximum: 1000 }),
        includeDeleted: s.boolean("Whether to include records marked as deleted."),
        all: s.boolean("Compatibility alias for includeDeleted."),
        hydrated: s.boolean("Whether to include human-readable labels for supported field types."),
        sort: s.array(
          "SmartSuite sort directives in the order they should be applied.",
          dynamicObjectSchema("A SmartSuite sort directive."),
        ),
        filter: dynamicObjectSchema("A SmartSuite group filter using the official filter syntax."),
      },
      { optional: ["offset", "limit", "includeDeleted", "all", "hydrated", "sort", "filter"] },
    ),
    outputSchema: s.object("A page of SmartSuite records.", {
      total: s.nonNegativeInteger("The total number of matching records."),
      offset: s.nonNegativeInteger("The current pagination offset."),
      limit: s.nonNegativeInteger("The response page limit."),
      records: s.array("The records returned for this page.", dynamicRecordSchema),
    }),
    followUpActions: ["smartsuite.get_record", "smartsuite.search_records"],
  }),
  defineProviderAction(service, {
    name: "search_records",
    description: "Search SmartSuite records using the official records list endpoint and a required filter.",
    requiredScopes: [],
    inputSchema: s.object(
      "Filters records in a SmartSuite Table.",
      {
        tableId: recordIdentityInputFields.tableId,
        offset: s.nonNegativeInteger("The number of matching records to skip."),
        limit: s.integer("The maximum number of records to return.", { minimum: 1, maximum: 1000 }),
        includeDeleted: s.boolean("Whether to include records marked as deleted."),
        all: s.boolean("Compatibility alias for includeDeleted."),
        hydrated: s.boolean("Whether to include human-readable labels for supported field types."),
        sort: s.array(
          "SmartSuite sort directives in the order they should be applied.",
          dynamicObjectSchema("A SmartSuite sort directive."),
        ),
        filter: dynamicObjectSchema("A required SmartSuite group filter using the official filter syntax."),
      },
      { optional: ["offset", "limit", "includeDeleted", "all", "hydrated", "sort"] },
    ),
    outputSchema: s.object("A page of SmartSuite records.", {
      total: s.nonNegativeInteger("The total number of matching records."),
      offset: s.nonNegativeInteger("The current pagination offset."),
      limit: s.nonNegativeInteger("The response page limit."),
      records: s.array("The records returned for this page.", dynamicRecordSchema),
    }),
    followUpActions: ["smartsuite.get_record", "smartsuite.update_record"],
  }),
  defineProviderAction(service, {
    name: "get_record",
    description: "Retrieve one record from a SmartSuite Table.",
    requiredScopes: [],
    inputSchema: s.object(
      "Identifies the SmartSuite record to retrieve.",
      {
        ...recordIdentityInputFields,
        hydrated: s.boolean("Whether to include human-readable labels for supported field types."),
      },
      { optional: ["hydrated"] },
    ),
    outputSchema: s.object("The requested SmartSuite record.", {
      record: dynamicRecordSchema,
    }),
    followUpActions: ["smartsuite.update_record"],
  }),
  defineProviderAction(service, {
    name: "create_record",
    description: "Create a record in a SmartSuite Table using its field slugs.",
    requiredScopes: [],
    inputSchema: s.object("Defines the SmartSuite record to create.", {
      tableId: recordIdentityInputFields.tableId,
      fields: dynamicObjectSchema("Record values keyed by SmartSuite Table field slug."),
    }),
    outputSchema: s.object("The created SmartSuite record.", {
      record: dynamicRecordSchema,
    }),
  }),
  defineProviderAction(service, {
    name: "update_record",
    description: "Partially update fields on a SmartSuite record without clearing omitted fields.",
    requiredScopes: [],
    inputSchema: s.object("Defines the SmartSuite record fields to update.", {
      ...recordIdentityInputFields,
      fields: dynamicObjectSchema("Record values keyed by SmartSuite Table field slug."),
    }),
    outputSchema: s.object("The updated SmartSuite record.", {
      record: dynamicRecordSchema,
    }),
    followUpActions: ["smartsuite.get_record"],
  }),
  defineProviderAction(service, {
    name: "delete_record",
    description: "Delete one record from a SmartSuite Table.",
    requiredScopes: [],
    inputSchema: s.object("Identifies the SmartSuite record to delete.", recordIdentityInputFields),
    outputSchema: s.object("Confirms that the SmartSuite record was deleted.", {
      deleted: s.boolean("Whether the record deletion succeeded."),
    }),
  }),
];
