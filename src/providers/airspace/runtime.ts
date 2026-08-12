import type { CredentialValidationResult } from "../../core/types.ts";
import type { ApiKeyProviderContext, ProviderFetch, ProviderRuntimeHandler } from "../provider-runtime.ts";
import type { AirspaceActionName } from "./actions.ts";

import {
  optionalInteger,
  optionalObjectArray,
  optionalRecord,
  optionalScalarString,
  optionalString,
} from "../../core/cast.ts";
import {
  createProviderTimeout,
  isAbortLikeError,
  ProviderRequestError,
  providerUserAgent,
  readProviderTextBody,
} from "../provider-runtime.ts";

export type AirspaceEnvironment = "production" | "test";

export interface AirspaceContext extends Pick<ApiKeyProviderContext, "apiKey" | "fetcher" | "signal"> {
  environment: AirspaceEnvironment;
}

type AirspacePhase = "validate" | "execute";

interface AirspaceRequestInput extends AirspaceContext {
  path: string;
  query?: Record<string, string | number | undefined>;
  phase: AirspacePhase;
}

const airspaceApiBaseUrls: Record<AirspaceEnvironment, string> = {
  production: "https://api.airspace.com/api/public/v3",
  test: "https://apitest.airspace.com/api/public/v3",
};
const airspaceRequestTimeoutMs = 30_000;
const airspaceMaxResponseBytes = 10 * 1024 * 1024;
const maxTrackingIdLength = 200;
const maxOrdersPerPage = 25;
const orderStatuses = new Set([
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
]);

export const airspaceActionHandlers: Record<AirspaceActionName, ProviderRuntimeHandler<AirspaceContext>> = {
  async list_orders(input, context) {
    const payload = await airspaceRequest({
      ...context,
      path: "/orders",
      query: {
        page: readOptionalIntegerInRange(input.page, "page", 1, 1_000_000),
        page_limit: readOptionalIntegerInRange(input.pageLimit, "pageLimit", 1, maxOrdersPerPage),
        "order[status]": readOptionalStatus(input.status),
        from_created_at: readOptionalFilter(input.fromCreatedAt, "fromCreatedAt"),
        to_created_at: readOptionalFilter(input.toCreatedAt, "toCreatedAt"),
        "order[references][reference]": readOptionalFilter(input.reference, "reference", 500),
        "order[references][context]": readOptionalFilter(input.referenceContext, "referenceContext", 500),
      },
      phase: "execute",
    });
    return normalizeOrderList(payload);
  },
  async get_order(input, context) {
    const trackingId = readTrackingId(input.trackingId);
    const payload = await airspaceRequest({
      ...context,
      path: `/orders/${encodeURIComponent(trackingId)}`,
      phase: "execute",
    });
    return { order: normalizeOrder(requireObject(payload, "Airspace order response").order) };
  },
  async get_order_events(input, context) {
    const trackingId = readTrackingId(input.trackingId);
    const payload = await airspaceRequest({
      ...context,
      path: `/orders/${encodeURIComponent(trackingId)}/events`,
      phase: "execute",
    });
    return normalizeOrderEvents(payload);
  },
};

export async function validateAirspaceCredential(
  input: { apiKey: string; values: Record<string, string> },
  fetcher: ProviderFetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const apiKey = readApiKey(input.apiKey);
  const environment = readAirspaceEnvironment(input.values.environment);
  const payload = await airspaceRequest({
    apiKey,
    environment,
    fetcher,
    signal,
    path: "/orders",
    query: { page: 1, page_limit: 1 },
    phase: "validate",
  });
  const root = requireObject(payload, "Airspace credential validation response");
  const firstOrder = optionalObjectArray(root.orders)[0];
  const companyId = optionalScalarString(firstOrder?.company_id);
  const companyName = optionalString(firstOrder?.company_name);

  return {
    profile: {
      accountId: companyId ?? `airspace-${environment}`,
      displayName: companyName ?? `Airspace ${environment} account`,
      grantedScopes: [],
    },
    grantedScopes: [],
    metadata: {
      apiBaseUrl: airspaceApiBaseUrls[environment],
      environment,
      validationEndpoint: "/orders?page=1&page_limit=1",
    },
  };
}

export function readAirspaceEnvironment(value: unknown): AirspaceEnvironment {
  const normalized = optionalString(value)?.toLowerCase();
  if (normalized === undefined || normalized === "production" || normalized === "api") {
    return "production";
  }
  if (normalized === "test" || normalized === "apitest") {
    return "test";
  }
  throw new ProviderRequestError(400, "environment must be production or test");
}

async function airspaceRequest(input: AirspaceRequestInput): Promise<unknown> {
  const url = buildAirspaceUrl(input.environment, input.path, input.query);
  const timeout = createProviderTimeout(input.signal, airspaceRequestTimeoutMs);
  try {
    const response = await input.fetcher(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.apiKey}`,
        "user-agent": providerUserAgent,
      },
      signal: timeout.signal,
    });
    const payload = await readAirspacePayload(response);
    if (!response.ok) {
      throw createAirspaceError(response.status, payload, input.phase, input.apiKey);
    }
    return payload;
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      throw error;
    }
    if (timeout.didTimeout() || isAbortLikeError(error)) {
      throw new ProviderRequestError(504, "Airspace request timed out");
    }
    const message = error instanceof Error ? error.message : "Airspace request failed";
    throw new ProviderRequestError(502, redactSecret(message, input.apiKey));
  } finally {
    timeout.cleanup();
  }
}

function buildAirspaceUrl(
  environment: AirspaceEnvironment,
  path: string,
  query?: Record<string, string | number | undefined>,
): URL {
  const url = new URL(path.startsWith("/") ? path.slice(1) : path, `${airspaceApiBaseUrls[environment]}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function readAirspacePayload(response: Response): Promise<unknown> {
  const text = await readProviderTextBody(response, "Airspace response", airspaceMaxResponseBytes);
  if (!text.trim()) {
    if (response.ok) {
      throw new ProviderRequestError(502, "Airspace returned an empty response");
    }
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (response.ok) {
      throw new ProviderRequestError(502, "Airspace returned invalid JSON");
    }
    return { message: text };
  }
}

function createAirspaceError(
  status: number,
  payload: unknown,
  phase: AirspacePhase,
  apiKey: string,
): ProviderRequestError {
  if (phase === "validate" && (status === 401 || status === 403)) {
    return new ProviderRequestError(400, "Airspace credentials were rejected");
  }
  const message = redactSecret(extractErrorMessage(payload) ?? `Airspace request failed with HTTP ${status}`, apiKey);
  if (status === 401 || status === 403) {
    return new ProviderRequestError(401, message);
  }
  if (status === 429) {
    return new ProviderRequestError(429, message);
  }
  return new ProviderRequestError(status >= 500 ? 502 : 400, message);
}

function extractErrorMessage(payload: unknown): string | undefined {
  const root = optionalRecord(payload);
  if (!root) {
    return undefined;
  }
  const direct = optionalString(root.error) ?? optionalString(root.message);
  if (direct) {
    return direct;
  }
  if (root.errors !== undefined) {
    try {
      return JSON.stringify(root.errors);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function normalizeOrderList(payload: unknown): Record<string, unknown> {
  const root = requireObject(payload, "Airspace order list response");
  if (!Array.isArray(root.orders) || root.orders.length > maxOrdersPerPage) {
    throw new ProviderRequestError(502, "Airspace order list response must contain at most 25 orders");
  }
  const pagination = optionalRecord(root.pagination);
  return {
    orders: root.orders.map(normalizeOrder),
    pagination: {
      page: optionalInteger(pagination?.page) ?? null,
      totalPages: optionalInteger(pagination?.total_pages) ?? null,
      pageLimit: optionalInteger(pagination?.page_limit) ?? null,
    },
    parameterErrors: optionalRecord(root.parameter_errors) ?? {},
  };
}

function normalizeOrder(value: unknown): Record<string, unknown> {
  const order = requireObject(value, "Airspace order");
  const flightInformation = optionalRecord(order.flight_information);
  return {
    trackingId: requireProviderString(order.tracking_id, "Airspace order tracking_id"),
    trackingUrl: optionalString(order.tracking_url) ?? null,
    orderNumber: optionalInteger(order.order_number) ?? null,
    status: requireProviderString(order.status, "Airspace order status"),
    currentSegment: optionalString(order.current_segment) ?? null,
    companyId: optionalScalarString(order.company_id) ?? null,
    companyName: optionalString(order.company_name) ?? null,
    serviceType: optionalString(order.service_type) ?? null,
    createdAt: optionalString(order.created_at) ?? null,
    pickupTime: optionalString(order.pickup_time) ?? null,
    estimatedPickupTime: optionalString(order.estimated_pickup_time) ?? null,
    estimatedDeliveryTime: optionalString(order.estimated_delivery_time) ?? null,
    deliveryTime: optionalString(order.delivery_time) ?? null,
    cancelledAt: optionalString(order.cancelled_at) ?? null,
    references: optionalObjectArray(order.references).map((reference) => ({
      reference: optionalScalarString(reference.reference) ?? null,
      context: optionalString(reference.context) ?? null,
    })),
    flightInformation: {
      flights: optionalObjectArray(flightInformation?.flights).map(normalizeFlight),
      airWaybillNumbers: Array.isArray(flightInformation?.air_waybill_numbers)
        ? flightInformation.air_waybill_numbers
            .map((number) => optionalScalarString(number))
            .filter((number): number is string => number !== undefined)
        : [],
    },
  };
}

function normalizeFlight(flight: Record<string, unknown>): Record<string, unknown> {
  return {
    airlineName: optionalString(flight.airline_name) ?? null,
    airlineIata: optionalString(flight.airline_iata) ?? null,
    flightNumber: optionalScalarString(flight.flight_number) ?? null,
    departureAirport: optionalString(flight.departure_airport) ?? null,
    departureAirportIata: optionalString(flight.departure_airport_iata) ?? null,
    departureTime: optionalString(flight.departure_time) ?? null,
    arrivalAirport: optionalString(flight.arrival_airport) ?? null,
    arrivalAirportIata: optionalString(flight.arrival_airport_iata) ?? null,
    arrivalTime: optionalString(flight.arrival_time) ?? null,
    status: optionalString(flight.status) ?? null,
  };
}

function normalizeOrderEvents(payload: unknown): Record<string, unknown> {
  const root = requireObject(payload, "Airspace order events response");
  if (!Array.isArray(root.events)) {
    throw new ProviderRequestError(502, "Airspace order events response is missing events");
  }
  return {
    trackingId: requireProviderString(root.tracking_id, "Airspace event tracking_id"),
    companyId: optionalScalarString(root.company_id) ?? null,
    companyName: optionalString(root.company_name) ?? null,
    orderNumber: optionalInteger(root.order_number) ?? null,
    events: root.events.map((value) => {
      const event = requireObject(value, "Airspace order event");
      return {
        type: requireProviderString(event.type, "Airspace event type"),
        name: requireProviderString(event.name, "Airspace event name"),
        occurredAtUtc: optionalString(event.occurred_at_utc) ?? null,
        message: optionalString(event.message) ?? null,
        delayCode: optionalString(event.delay_code) ?? null,
        delayCategory: optionalString(event.delay_category) ?? null,
        delayDescription: optionalString(event.delay_description) ?? null,
      };
    }),
  };
}

function readApiKey(value: unknown): string {
  const apiKey = optionalString(value);
  if (!apiKey) {
    throw new ProviderRequestError(400, "apiKey is required");
  }
  return apiKey;
}

function readTrackingId(value: unknown): string {
  const trackingId = optionalString(value);
  if (!trackingId || trackingId.length > maxTrackingIdLength || /[/?#]/.test(trackingId)) {
    throw new ProviderRequestError(400, "trackingId must be a non-empty path-safe identifier");
  }
  return trackingId;
}

function readOptionalIntegerInRange(
  value: unknown,
  fieldName: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const number = optionalInteger(value);
  if (number === undefined || number < minimum || number > maximum) {
    throw new ProviderRequestError(400, `${fieldName} must be an integer between ${minimum} and ${maximum}`);
  }
  return number;
}

function readOptionalStatus(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const status = optionalString(value);
  if (!status || !orderStatuses.has(status)) {
    throw new ProviderRequestError(400, "status is not a documented Airspace order status");
  }
  return status;
}

function readOptionalFilter(value: unknown, fieldName: string, maximumLength = 100): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const filter = optionalString(value);
  if (!filter || filter.length > maximumLength) {
    throw new ProviderRequestError(
      400,
      `${fieldName} must be a non-empty string of at most ${maximumLength} characters`,
    );
  }
  return filter;
}

function requireObject(value: unknown, fieldName: string): Record<string, unknown> {
  const record = optionalRecord(value);
  if (!record) {
    throw new ProviderRequestError(502, `${fieldName} must be an object`);
  }
  return record;
}

function requireProviderString(value: unknown, fieldName: string): string {
  const text = optionalScalarString(value);
  if (!text) {
    throw new ProviderRequestError(502, `${fieldName} is missing`);
  }
  return text;
}

function redactSecret(message: string, secret: string): string {
  return secret ? message.split(secret).join("[redacted]") : message;
}
