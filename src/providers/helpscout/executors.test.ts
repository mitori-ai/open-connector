import type { OAuthProviderContext } from "../provider-runtime.ts";

import { describe, expect, it, vi } from "vitest";
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

  it("does not expose an access token when Help Scout returns a JSON error", async () => {
    const fetcher = vi.fn(
      async (): Promise<Response> =>
        Response.json({ message: "Unauthorized", access_token: "provider-secret" }, { status: 401 }),
    );

    await expect(helpscoutActionHandlers.get_current_user({}, context(fetcher))).rejects.toMatchObject({
      status: 401,
      message: "Unauthorized",
    });
    await expect(helpscoutActionHandlers.get_current_user({}, context(fetcher))).rejects.not.toThrow("provider-secret");
  });
});
