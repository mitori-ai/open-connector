import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const carrierSchema = s.object("The carrier handling the myUnishippers shipment.", {
  code: s.nullableString("The carrier code."),
  name: s.nullableString("The carrier name."),
  serviceLevel: s.nullableString("The carrier service level."),
});

const statusSchema = s.object("The current myUnishippers shipment status.", {
  current: s.nonEmptyString("The current status label."),
  lastUpdated: s.nullableString("When the status was last updated."),
  estimatedDelivery: s.nullableString("The estimated delivery value reported by the carrier."),
});

const timelineEventSchema = s.object("One event in the shipment tracking history.", {
  status: s.nonEmptyString("The event status."),
  location: s.nullableString("The event location."),
  timestamp: s.nullableString("The event timestamp."),
  description: s.nullableString("The event description."),
  isVoided: s.boolean("Whether this event marks the shipment as voided."),
});

export type MyUnishippersActionName = "track_shipment";

export const myUnishippersActions: ActionDefinition[] = [
  defineProviderAction("myunishippers", {
    name: "track_shipment",
    description: "Track one myUnishippers shipment by its exact tracking number.",
    inputSchema: s.object("The shipment to track.", {
      trackingNumber: s.string({
        description: "The exact myUnishippers tracking number.",
        minLength: 1,
        maxLength: 200,
        pattern: "^[^,/?#]+$",
      }),
    }),
    outputSchema: s.object("A normalized myUnishippers tracking response.", {
      id: s.nullableString("The shipment identifier returned by myUnishippers."),
      trackingNumber: s.nonEmptyString("The shipment tracking number."),
      bolNumber: s.nullableString("The bill-of-lading number."),
      proNumber: s.nullableString("The carrier PRO number."),
      carrier: carrierSchema,
      status: statusSchema,
      timeline: s.array("The shipment tracking history.", timelineEventSchema),
      trackingUrl: s.url("The public myUnishippers tracking page."),
    }),
  }),
];
