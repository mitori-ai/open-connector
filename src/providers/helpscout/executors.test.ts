import type { OAuthProviderContext } from "../provider-runtime.ts";

import { describe, expect, it, vi } from "vitest";
import { helpscoutActions } from "./actions.ts";
import { validateHelpscoutCredential, helpscoutActionHandlers } from "./executors.ts";

const credential = {
  authType: "oauth2" as const,
  accessToken: "access-token-secret",
  tokenType: "Bearer",
  profile: { accountId: "oauth2", displayName: "OAuth Credential", grantedScopes: [] },
  metadata: { scope: "" },
};

function context(fetcher: typeof fetch): OAuthProviderContext {
  return {
    accessToken: credential.accessToken,
    tokenType: credential.tokenType,
    fetcher,
  };
}

describe("Help Scout Mailbox provider", () => {
  it("validates OAuth credentials with the resource-owner endpoint and returns safe identity", async () => {
    const fetcher = vi.fn(
      async (): Promise<Response> =>
        Response.json({
          id: 42,
          firstName: "Vernon",
          lastName: "Bear",
          email: "bear@example.com",
          role: "owner",
          companyId: 7,
        }),
    );

    await expect(validateHelpscoutCredential(credential, fetcher)).resolves.toEqual({
      profile: {
        accountId: "42",
        displayName: "Vernon Bear",
        grantedScopes: [],
      },
      grantedScopes: [],
      metadata: {
        apiBaseUrl: "https://api.helpscout.net/v2",
        validationEndpoint: "/users/me",
        userId: 42,
        companyId: 7,
      },
    });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.helpscout.net/v2/users/me");
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({
      authorization: "Bearer access-token-secret",
      accept: "application/json",
      "user-agent": "oomol-connect/0.1",
    });
  });

  it("lists conversations using only documented bounded filters", async () => {
    const fetcher = vi.fn(
      async (): Promise<Response> =>
        Response.json({
          _embedded: { conversations: [{ id: 9, subject: "Need help", status: "open" }] },
          page: { number: 0, size: 25, totalElements: 1, totalPages: 1 },
        }),
    );

    await expect(
      helpscoutActionHandlers.list_conversations(
        {
          page: 1,
          mailbox: "123,456",
          status: "open",
          assignedTo: 42,
          modifiedSince: "2026-08-01T00:00:00Z",
          query: '(subject:"help")',
          ignored: "not forwarded",
        },
        context(fetcher),
      ),
    ).resolves.toMatchObject({
      conversations: [{ id: 9, subject: "Need help", status: "open" }],
      page: { number: 0, size: 25, totalElements: 1, totalPages: 1 },
    });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://api.helpscout.net/v2/conversations?page=1&mailbox=123%2C456&status=open&assigned_to=42&modifiedSince=2026-08-01T00%3A00%3A00Z&query=%28subject%3A%22help%22%29",
    );
    expect(init.method).toBe("GET");
  });

  it("gets a conversation with the documented optional thread embed", async () => {
    const fetcher = vi.fn(async (): Promise<Response> => Response.json({ id: 9, subject: "Need help" }));

    await expect(
      helpscoutActionHandlers.get_conversation({ conversationId: 9, embed: "threads" }, context(fetcher)),
    ).resolves.toMatchObject({ conversation: { id: 9, subject: "Need help" } });
    const [url] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.helpscout.net/v2/conversations/9?embed=threads");
  });

  it("creates a conversation with official fields and reads back the created resource", async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        async (): Promise<Response> =>
          new Response(null, {
            status: 201,
            headers: { Location: "https://api.helpscout.net/v2/conversations/123" },
          }),
      )
      .mockImplementationOnce(
        async (): Promise<Response> =>
          Response.json({
            id: 123,
            subject: "Transport request",
            mailboxId: 85,
            assignee: { id: 42 },
            tags: [{ tag: "vip", token: "must not leak" }],
            nested: { access_token: "must not leak" },
          }),
      );

    const output = await helpscoutActionHandlers.create_conversation(
      {
        mailboxId: 85,
        customer: { email: "bear@example.com", firstName: "Vernon" },
        subject: "Transport request",
        body: "Please arrange a pickup.",
        cc: ["ops@example.com"],
        tags: ["vip"],
        assignee: 42,
      },
      context(fetcher),
    );
    expect(output).toMatchObject({ conversation: { id: 123, subject: "Transport request", mailboxId: 85 } });
    expect(JSON.stringify(output)).not.toContain("must not leak");

    const [, createInit] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const createPayload = JSON.parse(String(createInit.body)) as Record<string, unknown>;
    expect(createPayload.cc).toBeUndefined();
    expect(createPayload).toEqual({
      subject: "Transport request",
      customer: { email: "bear@example.com", firstName: "Vernon" },
      mailboxId: 85,
      type: "email",
      status: "active",
      threads: [
        {
          type: "customer",
          customer: { email: "bear@example.com", firstName: "Vernon" },
          text: "Please arrange a pickup.",
          cc: ["ops@example.com"],
        },
      ],
      tags: ["vip"],
      assignTo: 42,
    });
    const [readBackUrl, readBackInit] = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    expect(readBackUrl).toBe("https://api.helpscout.net/v2/conversations/123");
    expect(readBackInit.method).toBe("GET");
  });

  it("declares the create customer thread and CC semantics", () => {
    const createAction = helpscoutActions.find((action) => action.name === "create_conversation");
    expect(createAction).toBeDefined();
    expect(createAction?.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        cc: { type: "array" },
        customer: {
          type: "object",
          additionalProperties: false,
          anyOf: [{ required: ["id"] }, { required: ["email"] }],
        },
      },
    });
    expect(createAction?.inputSchema.required).toEqual(["mailboxId", "customer", "subject", "body"]);
  });

  it("sends only the official subject JSON Patch operation for updates", async () => {
    const fetcher = vi.fn(async (): Promise<Response> => new Response(null, { status: 204 }));

    await expect(
      helpscoutActionHandlers.update_conversation({ conversationId: 9, subject: "Updated subject" }, context(fetcher)),
    ).resolves.toEqual({ conversationId: 9, updated: true });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.helpscout.net/v2/conversations/9");
    expect(init.method).toBe("PATCH");
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({ op: "replace", path: "/subject", value: "Updated subject" });
  });

  it("updates the official assignee and complete tag list endpoints", async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(async (): Promise<Response> => new Response(null, { status: 204 }))
      .mockImplementationOnce(async (): Promise<Response> => new Response(null, { status: 204 }));

    await expect(
      helpscoutActionHandlers.update_conversation(
        { conversationId: 9, assignee: 42, tags: ["vip", "priority"] },
        context(fetcher),
      ),
    ).resolves.toEqual({ conversationId: 9, updated: true });

    const [assigneeUrl, assigneeInit] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(assigneeUrl).toBe("https://api.helpscout.net/v2/conversations/9");
    expect(assigneeInit.method).toBe("PATCH");
    expect(JSON.parse(String(assigneeInit.body))).toEqual({ op: "replace", path: "/assignTo", value: 42 });
    const [tagsUrl, tagsInit] = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    expect(tagsUrl).toBe("https://api.helpscout.net/v2/conversations/9/tags");
    expect(tagsInit.method).toBe("PUT");
    expect(JSON.parse(String(tagsInit.body))).toEqual({ tags: ["vip", "priority"] });
  });

  it("adds a reply with the official customer, CC, and assignment fields and reads back", async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        async (): Promise<Response> => new Response(null, { status: 201, headers: { "Resource-ID": "568" } }),
      )
      .mockImplementationOnce(async (): Promise<Response> => Response.json({ id: 9, subject: "Need help" }));

    await expect(
      helpscoutActionHandlers.reply_to_conversation(
        {
          conversationId: 9,
          customer: { email: "bear@example.com" },
          body: "We have confirmed the pickup.",
          cc: ["ops@example.com"],
          assignee: 42,
        },
        context(fetcher),
      ),
    ).resolves.toMatchObject({ conversationId: 9, threadId: 568, conversation: { id: 9 } });

    const [replyUrl, replyInit] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(replyUrl).toBe("https://api.helpscout.net/v2/conversations/9/reply");
    expect(replyInit.method).toBe("POST");
    expect(JSON.parse(String(replyInit.body))).toEqual({
      customer: { email: "bear@example.com" },
      text: "We have confirmed the pickup.",
      cc: ["ops@example.com"],
      assignTo: 42,
    });
    const [readBackUrl] = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    expect(readBackUrl).toBe("https://api.helpscout.net/v2/conversations/9?embed=threads");
  });

  it("adds an internal note through the official notes endpoint", async () => {
    const fetcher = vi.fn(
      async (): Promise<Response> => new Response(null, { status: 201, headers: { "Resource-ID": "567" } }),
    );

    await expect(
      helpscoutActionHandlers.add_note({ conversationId: 9, text: "Confirmed mailbox ownership." }, context(fetcher)),
    ).resolves.toEqual({ conversationId: 9, threadId: 567, created: true });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.helpscout.net/v2/conversations/9/notes");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ text: "Confirmed mailbox ownership." });
  });

  it("does not expose an access token when Help Scout returns a JSON error", async () => {
    const fetcher = vi.fn(
      async (): Promise<Response> =>
        Response.json(
          { message: `Unauthorized ${credential.accessToken}`, access_token: "provider-secret" },
          { status: 401 },
        ),
    );

    await expect(helpscoutActionHandlers.get_current_user({}, context(fetcher))).rejects.toMatchObject({
      status: 401,
      message: "Unauthorized [redacted]",
    });
  });
});
