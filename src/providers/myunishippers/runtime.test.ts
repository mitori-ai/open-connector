import { describe, expect, it, vi } from "vitest";
import { myUnishippersActionHandlers } from "./runtime.ts";

describe("myUnishippers tracking provider", () => {
  it("normalizes one public tracking response", async () => {
    const fetcher = vi.fn(
      async (): Promise<Response> =>
        Response.json({
          id: 123,
          trackingNumber: "1Z999AA10123456784",
          bolNumber: "BOL-10",
          proNumber: "PRO-20",
          carrier: { code: "UPS", name: "UPS", serviceLevel: "Ground" },
          status: {
            current: "In Transit",
            lastUpdated: "2026-08-12 09:00 NZST",
            estimatedDelivery: "2026-08-13",
          },
          timeline: [
            {
              status: "Created",
              location: "Auckland, NZ",
              timestamp: "2026-08-11 15:00 NZST",
              description: "Shipment created",
            },
          ],
        }),
    );

    await expect(
      myUnishippersActionHandlers.track_shipment({ trackingNumber: "1Z999AA10123456784" }, { fetcher }),
    ).resolves.toEqual({
      id: "123",
      trackingNumber: "1Z999AA10123456784",
      bolNumber: "BOL-10",
      proNumber: "PRO-20",
      carrier: { code: "UPS", name: "UPS", serviceLevel: "Ground" },
      status: {
        current: "In Transit",
        lastUpdated: "2026-08-12 09:00 NZST",
        estimatedDelivery: "2026-08-13",
      },
      timeline: [
        {
          status: "Created",
          location: "Auckland, NZ",
          timestamp: "2026-08-11 15:00 NZST",
          description: "Shipment created",
          isVoided: false,
        },
      ],
      trackingUrl: "https://track.myunishippers.com/track/1Z999AA10123456784",
    });

    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://track.myunishippers.com/api/track/1Z999AA10123456784");
    expect(init.headers).toMatchObject({ accept: "application/json" });
  });

  it("maps not-found responses and rejects mismatched tracking data", async () => {
    const notFoundFetcher = vi.fn(
      async (): Promise<Response> => Response.json({ error: "Shipment not found" }, { status: 404 }),
    );
    await expect(
      myUnishippersActionHandlers.track_shipment({ trackingNumber: "MISSING" }, { fetcher: notFoundFetcher }),
    ).rejects.toMatchObject({ status: 400, message: "Shipment not found" });

    const mismatchFetcher = vi.fn(
      async (): Promise<Response> =>
        Response.json({ trackingNumber: "OTHER", status: { current: "In Transit" }, timeline: [] }),
    );
    await expect(
      myUnishippersActionHandlers.track_shipment({ trackingNumber: "EXPECTED" }, { fetcher: mismatchFetcher }),
    ).rejects.toMatchObject({ status: 502, message: "myUnishippers returned a different tracking number" });
  });

  it("rejects batch identifiers so one action cannot return an ambiguous shipment", async () => {
    const fetcher = vi.fn();
    await expect(
      myUnishippersActionHandlers.track_shipment({ trackingNumber: "ONE,TWO" }, { fetcher }),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("myUnishippers batch tracking", () => {
  it("encodes commas and preserves separate results in requested order", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        results: [
          { identifier: "TWO", shipment: null, error: "Shipment not found" },
          { identifier: "ONE", shipment: { trackingNumber: "ONE", status: { current: "Delivered" } }, error: null },
        ],
      }),
    );
    const result = await myUnishippersActionHandlers.track_shipments({ trackingNumbers: ["ONE", "TWO"] }, { fetcher });
    expect(String((fetcher.mock.calls[0] as unknown as [URL])[0])).toBe(
      "https://track.myunishippers.com/api/track/ONE%2CTWO",
    );
    expect(result).toMatchObject({
      results: [
        { trackingNumber: "ONE", shipment: { trackingNumber: "ONE" }, error: null },
        { trackingNumber: "TWO", shipment: null, error: "Shipment not found" },
      ],
    });
  });

  it("supports a single flat shipment response", async () => {
    const fetcher = vi.fn(async () => Response.json({ trackingNumber: "ONE", status: { current: "Delivered" } }));
    await expect(
      myUnishippersActionHandlers.track_shipments({ trackingNumbers: ["ONE"] }, { fetcher }),
    ).resolves.toMatchObject({ results: [{ trackingNumber: "ONE", error: null }] });
  });

  it("rejects invalid batches before fetching", async () => {
    const fetcher = vi.fn();
    for (const trackingNumbers of [
      [],
      Array.from({ length: 26 }, (_, i) => String(i)),
      ["ONE", "one"],
      ["ONE,TWO"],
      ["ONE TWO"],
    ]) {
      await expect(myUnishippersActionHandlers.track_shipments({ trackingNumbers }, { fetcher })).rejects.toMatchObject(
        { status: 400 },
      );
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not accept missing, duplicated, or mismatched results", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        results: [
          { identifier: "ONE", shipment: { trackingNumber: "OTHER", status: { current: "Delivered" } } },
          { identifier: "TWO", shipment: {} },
          { identifier: "TWO", shipment: {} },
        ],
      }),
    );
    const result = await myUnishippersActionHandlers.track_shipments(
      { trackingNumbers: ["ONE", "TWO", "THREE"] },
      { fetcher },
    );
    expect(result).toMatchObject({
      results: [
        { shipment: null, error: "myUnishippers returned a different tracking number" },
        { shipment: null, error: "myUnishippers result is missing or duplicated" },
        { shipment: null, error: "myUnishippers result is missing or duplicated" },
      ],
    });
  });
});
