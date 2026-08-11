import type { IConnectionStore, StoredConnection } from "../../connection-service.ts";

import { describe, expect, it } from "vitest";
import { createCatalogStore } from "../../catalog-store.ts";
import { ConnectionService } from "../../connection-service.ts";
import { ProviderLoader } from "../provider-loader.ts";
import { provider } from "./definition.ts";
import { credentialValidators, executors } from "./executors.ts";

const secretMarker = "do-not-project-this-secret";

function createService(store: MemoryConnectionStore): ConnectionService {
  const loader = new ProviderLoader({
    [provider.service]: async () => ({ executors, credentialValidators }),
  });
  return new ConnectionService({
    catalog: createCatalogStore([provider]),
    providerLoader: loader,
    store,
  });
}

describe("mitori_secret_custody provider", () => {
  it("exposes no runtime action or proxy executor", () => {
    expect(executors).toEqual({});
  });
  it("validates JSON while returning a profile independent of the payload", async () => {
    const validator = credentialValidators.customCredential;
    expect(validator).toBeTypeOf("function");

    const result = await validator!(
      {
        values: {
          payload: JSON.stringify({ token: secretMarker, nested: { password: "another-secret" } }),
          purpose: "start-input",
        },
      },
      { fetcher: fetch },
    );

    expect(result).toEqual({
      profile: {
        accountId: "mitori_secret_custody:purpose:start-input",
        displayName: "Mitori Secret Custody",
        grantedScopes: [],
      },
    });
    expect(JSON.stringify(result)).not.toContain(secretMarker);
  });

  it("rejects malformed or non-object payloads without echoing secret input", async () => {
    const validator = credentialValidators.customCredential!;
    const malformed = `${secretMarker} not-json`;

    await expect(
      validator({ values: { payload: malformed, purpose: "start-input" } }, { fetcher: fetch }),
    ).rejects.toThrow("payload must contain valid JSON.");
    await expect(
      validator({ values: { payload: JSON.stringify([secretMarker]), purpose: "start-input" } }, { fetcher: fetch }),
    ).rejects.toThrow("payload must be a JSON object.");
    await expect(
      validator({ values: { payload: malformed, purpose: "start-input" } }, { fetcher: fetch }),
    ).rejects.not.toThrow(secretMarker);
  });

  it("stores only a safe connection summary and deletes the opaque connection", async () => {
    const store = new MemoryConnectionStore();
    const service = createService(store);
    const connectionName = "start-input-01";

    const summary = await service.connectWithCustomCredential(provider.service, {
      connectionName,
      values: {
        payload: JSON.stringify({ secret: secretMarker }),
        purpose: "start-input",
      },
    });

    expect(summary).toEqual({
      id: `${provider.service}:${connectionName}`,
      service: provider.service,
      connectionName,
      authType: "custom_credential",
      configured: true,
      virtual: false,
      default: false,
      profile: {
        accountId: "mitori_secret_custody:purpose:start-input",
        displayName: "Mitori Secret Custody",
        grantedScopes: [],
      },
    });
    expect(JSON.stringify(summary)).not.toContain(secretMarker);
    expect(await service.listConnections()).toEqual([summary]);
    expect(JSON.stringify(await service.getConnectionSummary(provider.service, connectionName))).not.toContain(
      secretMarker,
    );

    const stored = await service.getCredential(provider.service, connectionName);
    expect(stored?.authType).toBe("custom_credential");
    expect(stored && JSON.stringify(stored)).toContain(secretMarker);

    await expect(service.disconnect(provider.service, connectionName)).resolves.toEqual({
      service: provider.service,
      connectionName,
      configured: false,
    });
    await expect(service.listConnections()).resolves.toEqual([]);
  });
});

class MemoryConnectionStore implements IConnectionStore {
  private readonly values = new Map<string, StoredConnection>();
  private revision = 0;

  async get(service: string, connectionName: string): Promise<StoredConnection | undefined> {
    return this.values.get(`${service}:${connectionName}`);
  }

  async set(
    service: string,
    connectionName: string,
    credential: StoredConnection["credential"],
  ): Promise<StoredConnection> {
    const stored = {
      id: `${service}:${connectionName}`,
      revision: String(++this.revision),
      service,
      connectionName,
      credential,
    };
    this.values.set(`${service}:${connectionName}`, stored);
    return stored;
  }

  async updateCredential(input: StoredConnection): Promise<boolean> {
    const key = `${input.service}:${input.connectionName}`;
    const current = this.values.get(key);
    if (!current || current.revision !== input.revision) return false;
    this.values.set(key, { ...input, revision: String(++this.revision) });
    return true;
  }

  async delete(service: string, connectionName: string): Promise<void> {
    this.values.delete(`${service}:${connectionName}`);
  }

  async list(): Promise<StoredConnection[]> {
    return [...this.values.values()];
  }
}
