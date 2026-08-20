import { describe, expect, it, vi } from "vitest";
import { airspaceActionHandlers, validateAirspaceCredential } from "./runtime.ts";

const apiKey = "airspace-test-secret";

function context(fetcher: typeof fetch) {
  return { apiKey, environment: "test" as const, fetcher };
}

describe("Airspace provider runtime", () => {
  it("validates bearer credentials against the selected official v3 environment", async () => {
    const fetcher = vi.fn(
      async (): Promise<Response> =>
        Response.json({
          orders: [{ tracking_id: "AT123", status: "active", company_id: "COMPANY1", company_name: "CryoFuture" }],
          pagination: { page: 1, total_pages: 1, page_limit: 1 },
          parameter_errors: {},
        }),
    );

    await expect(validateAirspaceCredential({ apiKey, values: { environment: "test" } }, fetcher)).resolves.toEqual({
      profile: { accountId: "COMPANY1", displayName: "CryoFuture", grantedScopes: [] },
      grantedScopes: [],
      metadata: {
        apiBaseUrl: "https://apitest.airspace.com/api/public/v3",
        environment: "test",
        validationEndpoint: "/orders?page=1&page_limit=1",
      },
    });

    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://apitest.airspace.com/api/public/v3/orders?page=1&page_limit=1");
    expect(init.headers).toMatchObject({ authorization: `Bearer ${apiKey}`, accept: "application/json" });
  });

  it("normalizes official order fields needed for shipment confirmation", async () => {
    const fetcher = vi.fn(
      async (): Promise<Response> =>
        Response.json({
          order: {
            tracking_id: "ATYFGD4P4J",
            tracking_url: "https://apitest.airspace.com/asap/tracking/ATYFGD4P4J",
            order_number: 72,
            status: "customer_completed",
            current_segment: "pre_transit",
            company_id: "ABCD123456",
            company_name: "CryoFuture",
            service_type: "optimize_for_time",
            created_at: "2026-08-11T20:00:00.000Z",
            estimated_pickup_time: "2026-08-12T01:00:00.000Z",
            estimated_delivery_time: "2026-08-12T04:00:00.000Z",
            references: [{ reference: "12345", context: "Ticket Number" }],
            flight_information: {
              flights: [
                {
                  airline_name: "Air New Zealand",
                  airline_iata: "NZ",
                  flight_number: "NZ6",
                  departure_airport_iata: "AKL",
                  arrival_airport_iata: "LAX",
                  status: "Scheduled",
                },
              ],
              air_waybill_numbers: ["123-45678901"],
            },
          },
        }),
    );

    await expect(airspaceActionHandlers.get_order({ trackingId: "ATYFGD4P4J" }, context(fetcher))).resolves.toEqual({
      order: expect.objectContaining({
        trackingId: "ATYFGD4P4J",
        orderNumber: 72,
        status: "customer_completed",
        companyId: "ABCD123456",
        serviceType: "optimize_for_time",
        references: [{ reference: "12345", context: "Ticket Number" }],
        flightInformation: {
          flights: [
            expect.objectContaining({ airlineName: "Air New Zealand", airlineIata: "NZ", flightNumber: "NZ6" }),
          ],
          airWaybillNumbers: ["123-45678901"],
        },
      }),
    });
    const [url] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://apitest.airspace.com/api/public/v3/orders/ATYFGD4P4J");
  });

  it("retrieves and normalizes order events", async () => {
    const fetcher = vi.fn(
      async (): Promise<Response> =>
        Response.json({
          tracking_id: "ATYFGD4P4J",
          company_id: "ABCD123456",
          company_name: "CryoFuture",
          order_number: 72,
          events: [
            {
              type: "status",
              name: "customer_completed",
              occurred_at_utc: "2026-08-12T01:00:00.000Z",
              message: null,
              delay_code: null,
              delay_category: null,
              delay_description: null,
            },
          ],
        }),
    );

    await expect(
      airspaceActionHandlers.get_order_events({ trackingId: "ATYFGD4P4J" }, context(fetcher)),
    ).resolves.toEqual({
      trackingId: "ATYFGD4P4J",
      companyId: "ABCD123456",
      companyName: "CryoFuture",
      orderNumber: 72,
      events: [
        {
          type: "status",
          name: "customer_completed",
          occurredAtUtc: "2026-08-12T01:00:00.000Z",
          message: null,
          delayCode: null,
          delayCategory: null,
          delayDescription: null,
        },
      ],
    });
  });

  it("rejects invalid environments and never exposes the API token in provider errors", async () => {
    const fetcher = vi.fn(
      async (): Promise<Response> => Response.json({ error: `Unauthorized ${apiKey}` }, { status: 401 }),
    );

    await expect(
      validateAirspaceCredential({ apiKey, values: { environment: "test" } }, fetcher),
    ).rejects.toMatchObject({
      status: 400,
      message: "Airspace credentials were rejected",
    });
    await expect(
      validateAirspaceCredential({ apiKey, values: { environment: "staging" } }, fetcher),
    ).rejects.toMatchObject({ status: 400, message: "environment must be production or test" });
  });
});
