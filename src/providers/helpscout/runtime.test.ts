import { describe, expect, it, vi } from "vitest";
import { helpscoutActions } from "./actions.ts";
import { helpscoutActionHandlers } from "./runtime.ts";

const accessToken = "helpscout-secret-access-token";

describe("Help Scout compatibility runtime", () => {
  it("keeps the Mitori public actions and legacy conversation filters", async () => {
    expect(helpscoutActions.map((action) => action.name)).toEqual(
      expect.arrayContaining(["get_current_user", "list_conversations", "get_conversation", "update_conversation"]),
    );

    const fetchMock = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        _embedded: { conversations: [] },
        page: { number: 0, size: 25, totalElements: 0, totalPages: 0 },
      }),
    );
    const fetcher = fetchMock as typeof fetch;
    await helpscoutActionHandlers.list_conversations!(
      {
        mailbox: "12,34",
        folder: 56,
        tag: "priority,vip",
        assignedTo: 78,
        number: 90,
        embed: "threads",
        customFieldsByIds: "1:value",
      },
      { accessToken, fetcher },
    );

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      mailbox: "12,34",
      folder: "56",
      tag: "priority,vip",
      assigned_to: "78",
      number: "90",
      embed: "threads",
      customFieldsByIds: "1:value",
    });
  });

  it("projects the current user and keeps subject-only conversation updates", async () => {
    const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      if (url.endsWith("/users/me")) {
        return Response.json({
          id: 42,
          firstName: "Ada",
          lastName: "Lovelace",
          email: "ada@example.com",
          role: "admin",
          companyId: 7,
          accessToken,
        });
      }
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({ op: "replace", path: "/subject", value: "Updated" });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await expect(helpscoutActionHandlers.get_current_user!({}, { accessToken, fetcher })).resolves.toEqual({
      profile: {
        id: 42,
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        role: "admin",
        companyId: 7,
      },
    });
    await expect(
      helpscoutActionHandlers.update_conversation!({ conversationId: 9, subject: "Updated" }, { accessToken, fetcher }),
    ).resolves.toEqual({ conversationId: 9, updated: true });
  });

  it("redacts access tokens from provider errors", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ message: `provider echoed ${accessToken}` }, { status: 400 }),
    ) as typeof fetch;

    const error = await captureError(() =>
      helpscoutActionHandlers.get_conversation!({ conversationId: 9 }, { accessToken, fetcher }),
    );
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain(accessToken);
  });

  it("rejects oversized provider errors without echoing their body", async () => {
    const marker = "helpscout-oversized-body-marker";
    const fetcher = vi.fn(
      async () => new Response(`${"x".repeat(1024 * 1024)}${marker}`, { status: 500 }),
    ) as typeof fetch;

    const error = await captureError(() =>
      helpscoutActionHandlers.get_conversation!({ conversationId: 9 }, { accessToken, fetcher }),
    );
    expect(error.message).not.toContain(marker);
    expect(error.message).toContain("exceeds 1048576 bytes");
  });
});

async function captureError(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("Expected operation to fail");
}

describe("Help Scout create conversation Cc", () => {
  it.each(["customer", "reply"])("preserves customer identity and initial %s thread recipients", async (threadType) => {
    const fetcher = vi.fn(
      async (_request: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 201, headers: { "resource-id": "9001" } }),
    );
    await helpscoutActionHandlers.create_conversation!(
      {
        inboxId: 7,
        customerEmail: "sending@example.invalid",
        cc: ["receiving@example.invalid"],
        subject: "TEST communication",
        text: "Hello",
        threadType,
      },
      { accessToken, fetcher: fetcher as typeof fetch },
    );
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.customer).toEqual({ email: "sending@example.invalid" });
    expect(body.threads).toEqual([
      {
        type: threadType,
        text: "Hello",
        customer: { email: "sending@example.invalid" },
        cc: ["receiving@example.invalid"],
      },
    ]);
    expect(body).not.toHaveProperty("cc");
  });
  it("rejects malformed Cc and note recipients before network access", async () => {
    const fetcher = vi.fn();
    for (const input of [
      { cc: ["not-an-email"] },
      { cc: ["a@example.invalid\r\nBcc: other@example.invalid"] },
      { threadType: "note", cc: ["a@example.invalid"] },
    ]) {
      await expect(
        helpscoutActionHandlers.create_conversation!(
          { inboxId: 7, customerEmail: "sending@example.invalid", subject: "TEST", text: "Hello", ...input },
          { accessToken, fetcher: fetcher as typeof fetch },
        ),
      ).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps omitted Cc absent for existing callers", async () => {
    const fetcher = vi.fn(
      async (_request: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 201 }),
    );
    await helpscoutActionHandlers.create_conversation!(
      { inboxId: 7, customerEmail: "sending@example.invalid", subject: "TEST", text: "Hello" },
      { accessToken, fetcher: fetcher as typeof fetch },
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).threads[0]).not.toHaveProperty("cc");
  });
});
