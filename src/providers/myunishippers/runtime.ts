import type { ProviderRuntimeHandler } from "../provider-runtime.ts";
import type { MyUnishippersActionName } from "./actions.ts";

import {
  optionalBoolean,
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

interface MyUnishippersContext {
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

const myUnishippersBaseUrl = "https://track.myunishippers.com";
const requestTimeoutMs = 30_000;
const maxResponseBytes = 5 * 1024 * 1024;

export const myUnishippersActionHandlers: Record<
  MyUnishippersActionName,
  ProviderRuntimeHandler<MyUnishippersContext>
> = {
  async track_shipment(input, context) {
    const trackingNumber = readTrackingNumber(input.trackingNumber);
    const payload = await requestMyUnishippers(trackingNumber, context);
    return normalizeShipment(payload, trackingNumber);
  },
};

async function requestMyUnishippers(trackingNumber: string, context: MyUnishippersContext): Promise<unknown> {
  const url = new URL(`/api/track/${encodeURIComponent(trackingNumber)}`, myUnishippersBaseUrl);
  const timeout = createProviderTimeout(context.signal, requestTimeoutMs);
  try {
    const response = await context.fetcher(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": providerUserAgent,
      },
      signal: timeout.signal,
    });
    const payload = await readPayload(response);
    if (!response.ok) {
      const message = extractErrorMessage(payload) ?? `myUnishippers tracking failed with HTTP ${response.status}`;
      throw new ProviderRequestError(response.status === 429 ? 429 : response.status >= 500 ? 502 : 400, message);
    }
    return payload;
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      throw error;
    }
    if (timeout.didTimeout() || isAbortLikeError(error)) {
      throw new ProviderRequestError(504, "myUnishippers tracking request timed out");
    }
    throw new ProviderRequestError(502, "myUnishippers tracking request failed");
  } finally {
    timeout.cleanup();
  }
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await readProviderTextBody(response, "myUnishippers response", maxResponseBytes);
  if (!text.trim()) {
    if (response.ok) {
      throw new ProviderRequestError(502, "myUnishippers returned an empty response");
    }
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (response.ok) {
      throw new ProviderRequestError(502, "myUnishippers returned invalid JSON");
    }
    return { error: text };
  }
}

function normalizeShipment(payload: unknown, requestedTrackingNumber: string): Record<string, unknown> {
  const shipment = requireObject(payload, "myUnishippers shipment response");
  const trackingNumber = requireString(shipment.trackingNumber, "myUnishippers trackingNumber");
  if (trackingNumber.toUpperCase() !== requestedTrackingNumber.toUpperCase()) {
    throw new ProviderRequestError(502, "myUnishippers returned a different tracking number");
  }
  const carrier = optionalRecord(shipment.carrier);
  const status = requireObject(shipment.status, "myUnishippers status");

  return {
    id: optionalScalarString(shipment.id) ?? null,
    trackingNumber,
    bolNumber: optionalScalarString(shipment.bolNumber) ?? null,
    proNumber: optionalScalarString(shipment.proNumber) ?? null,
    carrier: {
      code: optionalString(carrier?.code) ?? null,
      name: optionalString(carrier?.name) ?? null,
      serviceLevel: optionalString(carrier?.serviceLevel) ?? null,
    },
    status: {
      current: requireString(status.current, "myUnishippers current status"),
      lastUpdated: optionalString(status.lastUpdated) ?? null,
      estimatedDelivery: optionalString(status.estimatedDelivery) ?? null,
    },
    timeline: optionalObjectArray(shipment.timeline).map((event) => ({
      status: requireString(event.status, "myUnishippers timeline status"),
      location: optionalString(event.location) ?? null,
      timestamp: optionalString(event.timestamp) ?? null,
      description: optionalString(event.description) ?? null,
      isVoided: optionalBoolean(event.isVoided) ?? false,
    })),
    trackingUrl: `${myUnishippersBaseUrl}/track/${encodeURIComponent(trackingNumber)}`,
  };
}

function readTrackingNumber(value: unknown): string {
  const trackingNumber = optionalString(value);
  if (!trackingNumber || trackingNumber.length > 200 || /[,/?#]/.test(trackingNumber)) {
    throw new ProviderRequestError(400, "trackingNumber must be one exact path-safe tracking number");
  }
  return trackingNumber;
}

function requireObject(value: unknown, fieldName: string): Record<string, unknown> {
  const record = optionalRecord(value);
  if (!record) {
    throw new ProviderRequestError(502, `${fieldName} must be an object`);
  }
  return record;
}

function requireString(value: unknown, fieldName: string): string {
  const text = optionalScalarString(value);
  if (!text) {
    throw new ProviderRequestError(502, `${fieldName} is missing`);
  }
  return text;
}

function extractErrorMessage(payload: unknown): string | undefined {
  const record = optionalRecord(payload);
  return optionalString(record?.error) ?? optionalString(record?.message);
}
