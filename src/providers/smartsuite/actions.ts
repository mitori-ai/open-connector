import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "smartsuite";

const tableId = s.string({
  description: "SmartSuite Table (formerly App) identifier.",
  minLength: 1,
  maxLength: 200,
  pattern: "^[^/?#]+$",
});
const recordId = s.string({
  description: "SmartSuite record identifier.",
  minLength: 1,
  maxLength: 200,
  pattern: "^[^/?#]+$",
});
const fieldSlug = s.string({
  description: "SmartSuite field ID or slug.",
  minLength: 1,
  maxLength: 200,
  pattern: "^[^/?#]+$",
});

const dateMode = s.stringEnum(
  [
    "today",
    "yesterday",
    "one_week_ago",
    "one_week_from_now",
    "one_month_ago",
    "one_month_from_now",
    "one_year_ago",
    "one_year_from_now",
    "next_number_of_days",
    "past_number_of_days",
    "date_range",
    "exact_date",
  ],
  { description: "SmartSuite date filter mode documented for record filtering." },
);
const dateFilterValue = s.object(
  {
    date_mode: dateMode,
    date_mode_value: s.string({
      description: "Date mode value, such as an ISO date or a number of days.",
      minLength: 1,
      maxLength: 100,
    }),
  },
  { required: ["date_mode", "date_mode_value"], description: "SmartSuite date filter value object." },
);
const filterValue = {
  anyOf: [
    s.string({ description: "Text or identifier comparison value.", maxLength: 1000 }),
    s.number("Numeric comparison value."),
    s.boolean("Boolean comparison value."),
    { type: "null", description: "Null for comparisons such as is_empty." },
    s.array(s.string({ description: "Identifier or select value.", minLength: 1, maxLength: 200 }), {
      description: "List comparison value for linked, user, tag, or select fields.",
      maxItems: 100,
    }),
    dateFilterValue,
  ],
  description: "SmartSuite filter value; its shape depends on the field type.",
};

const comparison = s.stringEnum(
  [
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
  ],
  { description: "Comparison operator documented by SmartSuite for the selected field type." },
);
const filterField = s.object(
  {
    field: fieldSlug,
    comparison,
    value: filterValue,
  },
  { required: ["field", "comparison", "value"], description: "One SmartSuite record filter." },
);
const filter = s.object(
  {
    operator: s.stringEnum(["and", "or"], { description: "Whether all or any filter fields must match." }),
    fields: s.array(filterField, { description: "Filter fields evaluated by SmartSuite.", maxItems: 100 }),
  },
  { required: ["operator", "fields"], description: "SmartSuite record filter expression." },
);
const sort = s.object(
  {
    field: fieldSlug,
    direction: s.stringEnum(["asc", "desc"], { description: "Sort direction." }),
  },
  { required: ["field", "direction"], description: "One SmartSuite record sort directive." },
);

const record = s.looseObject("SmartSuite record object. Field keys are table-specific and returned by SmartSuite.");
const recordListOutput = s.actionOutput(
  {
    records: s.array(record, { description: "Records returned by SmartSuite.", maxItems: 1000 }),
    total: s.nullableInteger("Total records reported by SmartSuite."),
    offset: s.nullableInteger("Current record offset reported by SmartSuite."),
    limit: s.nullableInteger("Page size reported by SmartSuite."),
  },
  "Normalized SmartSuite record list response.",
);
const recordOutput = s.actionOutput({ record }, "Normalized SmartSuite record response.");

const listProperties = {
  tableId,
  offset: s.nonNegativeInteger("Number of records to skip before this page.", { maximum: 1_000_000 }),
  limit: s.integer({
    description: "Maximum records to return. SmartSuite permits at most 1000.",
    minimum: 1,
    maximum: 1000,
  }),
  all: s.boolean("Whether to include deleted records, as supported by SmartSuite."),
  hydrated: s.boolean("Whether to ask SmartSuite for human-readable values for ID fields."),
  sort: s.array(sort, { description: "SmartSuite sort directives.", maxItems: 20 }),
  filter,
};

const listInput = s.object(listProperties, {
  optional: ["offset", "limit", "all", "hydrated", "sort", "filter"],
  description: "Input for listing SmartSuite records.",
});
const searchInput = s.object(listProperties, {
  optional: ["offset", "limit", "all", "hydrated", "sort"],
  required: ["tableId", "filter"],
  description: "Input for searching SmartSuite records with the official list endpoint filter syntax.",
});
const getInput = s.object(
  { tableId, recordId, hydrated: s.boolean("Whether to ask SmartSuite for human-readable values for ID fields.") },
  { optional: ["hydrated"], description: "Input for retrieving one SmartSuite record." },
);
const updateFields = {
  type: "object",
  minProperties: 1,
  maxProperties: 100,
  additionalProperties: true,
  description: "Mutable SmartSuite record fields to patch. System-generated fields are rejected by the executor.",
};
const updateInput = s.object(
  {
    tableId,
    recordId,
    fields: updateFields,
  },
  { required: ["tableId", "recordId", "fields"], description: "Input for partially updating one SmartSuite record." },
);

export type SmartSuiteActionName = "list_records" | "search_records" | "get_record" | "update_record";

export const smartsuiteActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "list_records",
    description:
      "List SmartSuite records using the official records list endpoint with bounded pagination, sorting, and filtering.",
    inputSchema: listInput,
    outputSchema: recordListOutput,
    followUpActions: ["smartsuite.get_record", "smartsuite.search_records"],
  }),
  defineProviderAction(service, {
    name: "search_records",
    description:
      "Search SmartSuite records through the official records list endpoint using a required typed filter expression.",
    inputSchema: searchInput,
    outputSchema: recordListOutput,
    followUpActions: ["smartsuite.get_record", "smartsuite.update_record"],
  }),
  defineProviderAction(service, {
    name: "get_record",
    description: "Retrieve one SmartSuite record by table and record identifier.",
    inputSchema: getInput,
    outputSchema: recordOutput,
    followUpActions: ["smartsuite.update_record"],
  }),
  defineProviderAction(service, {
    name: "update_record",
    description: "Partially update mutable fields on one SmartSuite record using the official PATCH endpoint.",
    inputSchema: updateInput,
    outputSchema: recordOutput,
    followUpActions: ["smartsuite.get_record"],
  }),
];
