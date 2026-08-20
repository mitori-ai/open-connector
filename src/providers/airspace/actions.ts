import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "airspace";

const trackingId = s.string({
  description: "Airspace tracking ID or order number.",
  minLength: 1,
  maxLength: 200,
  pattern: "^[^/?#]+$",
});

const nullableDateTime = (description: string) => s.nullable(s.dateTime(description));

const referenceSchema = s.object("An identifying reference attached to the Airspace order.", {
  reference: s.nullableString("The reference value."),
  context: s.nullableString("The configured reference label or context."),
});

const flightSchema = s.object("A flight assigned to the Airspace order.", {
  airlineName: s.nullableString("The airline name."),
  airlineIata: s.nullableString("The airline IATA code."),
  flightNumber: s.nullableString("The flight number."),
  departureAirport: s.nullableString("The departure airport name."),
  departureAirportIata: s.nullableString("The departure airport IATA code."),
  departureTime: nullableDateTime("The UTC departure time."),
  arrivalAirport: s.nullableString("The arrival airport name."),
  arrivalAirportIata: s.nullableString("The arrival airport IATA code."),
  arrivalTime: nullableDateTime("The UTC arrival time."),
  status: s.nullableString("The flight status reported by Airspace."),
});

const flightInformationSchema = s.object("Flight and air-waybill information for the order.", {
  flights: s.array("Flights assigned to the order.", flightSchema),
  airWaybillNumbers: s.array("Air waybill numbers assigned to the order.", s.nonEmptyString("Air waybill number.")),
});

const orderSchema = s.object("A normalized Airspace v3 order.", {
  trackingId: s.nonEmptyString("The Airspace tracking ID."),
  trackingUrl: s.nullable(s.url("The Airspace-hosted tracking URL.")),
  orderNumber: s.nullableInteger("The Airspace order number."),
  status: s.nonEmptyString("The current Airspace order status."),
  currentSegment: s.nullableString("The current shipment segment."),
  companyId: s.nullableString("The Airspace company identifier."),
  companyName: s.nullableString("The Airspace company name."),
  serviceType: s.nullableString("The selected Airspace service type."),
  createdAt: nullableDateTime("When the order was created."),
  pickupTime: nullableDateTime("The actual or scheduled pickup time."),
  estimatedPickupTime: nullableDateTime("The latest estimated pickup time."),
  estimatedDeliveryTime: nullableDateTime("The latest estimated delivery time."),
  deliveryTime: nullableDateTime("The actual delivery time."),
  cancelledAt: nullableDateTime("When the order was cancelled."),
  references: s.array("References attached to the order.", referenceSchema),
  flightInformation: flightInformationSchema,
});

const paginationSchema = s.object("Airspace page metadata.", {
  page: s.nullableInteger("The current page number."),
  totalPages: s.nullableInteger("The total number of pages."),
  pageLimit: s.nullableInteger("The requested page size."),
});

const eventSchema = s.object("A normalized Airspace order event.", {
  type: s.nonEmptyString("The event type, such as status or delay."),
  name: s.nonEmptyString("The provider-native event name."),
  occurredAtUtc: nullableDateTime("When the event occurred in UTC."),
  message: s.nullableString("The event message."),
  delayCode: s.nullableString("The Airspace delay code."),
  delayCategory: s.nullableString("The Airspace delay category."),
  delayDescription: s.nullableString("The Airspace delay description."),
});

const orderStatuses = [
  "active",
  "draft",
  "will_call",
  "pending",
  "customer_completed",
  "ops_acknowledged",
  "available_for_pickup",
  "en_route_to_pickup",
  "arrived_at_pickup_location",
  "recovered_from_airline",
  "en_route_to_destination",
  "arrived_at_destination",
  "accepted_by_airline",
  "verified_onboard",
  "reached_destination_airport",
  "held_at_warehouse",
  "delivered",
  "approved_for_invoicing",
  "cost_complete",
  "admin_canceled",
] as const;

export type AirspaceActionName = "list_orders" | "get_order" | "get_order_events";

export const airspaceActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "list_orders",
    description: "List Airspace orders with bounded pagination and documented shipment filters.",
    inputSchema: s.object(
      "Filters for listing Airspace orders.",
      {
        page: s.positiveInteger("The page number to retrieve."),
        pageLimit: s.integer({ description: "The number of orders per page.", minimum: 1, maximum: 25 }),
        status: s.stringEnum(orderStatuses, { description: "The Airspace order status to include." }),
        fromCreatedAt: s.string("Include orders created at or after this Airspace date-time value."),
        toCreatedAt: s.string("Include orders created at or before this Airspace date-time value."),
        reference: s.string("Filter by an order reference value.", { minLength: 1, maxLength: 500 }),
        referenceContext: s.string("Filter by an order reference context.", { minLength: 1, maxLength: 500 }),
      },
      { optional: ["page", "pageLimit", "status", "fromCreatedAt", "toCreatedAt", "reference", "referenceContext"] },
    ),
    outputSchema: s.object("A normalized page of Airspace orders.", {
      orders: s.array("Orders returned by Airspace.", orderSchema, { maxItems: 25 }),
      pagination: paginationSchema,
      parameterErrors: s.looseObject("Airspace query-parameter errors, when any were reported."),
    }),
    followUpActions: ["airspace.get_order", "airspace.get_order_events"],
  }),
  defineProviderAction(service, {
    name: "get_order",
    description: "Retrieve one Airspace order by tracking ID or order number.",
    inputSchema: s.object("The Airspace order lookup.", { trackingId }),
    outputSchema: s.object("The matching Airspace order.", { order: orderSchema }),
    followUpActions: ["airspace.get_order_events"],
  }),
  defineProviderAction(service, {
    name: "get_order_events",
    description: "Retrieve the status, delay, and customs events for an Airspace order.",
    inputSchema: s.object("The Airspace order event lookup.", { trackingId }),
    outputSchema: s.object("The event history for an Airspace order.", {
      trackingId: s.nonEmptyString("The Airspace tracking ID."),
      companyId: s.nullableString("The Airspace company identifier."),
      companyName: s.nullableString("The Airspace company name."),
      orderNumber: s.nullableInteger("The Airspace order number."),
      events: s.array("Events returned for the order.", eventSchema),
    }),
    followUpActions: ["airspace.get_order"],
  }),
];
