import { describe, expect, it, vi } from "vitest";
import {
  gatewayClientSenderFields,
  gatewayClientSessionCreator,
  isGatewayClientProfilePending,
  refreshPendingGatewayClientProfile,
} from "./gateway-client-identity.js";
import type { GatewayClient } from "./types.js";

describe("gateway client identity", () => {
  it("sender provenance comes only from a live verified profile", () => {
    const profile = {
      profileId: "profile-id",
      displayName: "Person",
      hasAvatar: false,
      updatedAt: 1,
    };
    expect(
      gatewayClientSenderFields({ authenticatedUserId: "profile-id" } as GatewayClient),
    ).toEqual({ sender: { id: "profile-id" } });
    expect(
      gatewayClientSenderFields({ authenticatedUserProfile: profile } as GatewayClient),
    ).toEqual({
      sender: { id: "profile-id", name: "Person", identity: { type: "profile", id: "profile-id" } },
    });
    expect(
      gatewayClientSenderFields({
        authenticatedUserProfile: profile,
        internal: { syntheticClient: true },
      } as GatewayClient).sender,
    ).not.toHaveProperty("identity");
  });

  it("overrides sender attribution without replacing the authorizing identity", () => {
    const client = {
      authenticatedUserProfile: {
        profileId: "owner",
        displayName: "Owner",
        hasAvatar: false,
        updatedAt: 1,
      },
      internal: {
        syntheticClient: true,
        senderAttribution: {
          id: "alice",
          name: "Suggested by Alice",
          identity: { type: "profile", id: "alice" },
        },
      },
    } as GatewayClient;

    expect(gatewayClientSessionCreator(client)).toEqual({
      type: "human",
      id: "owner",
      label: "Owner",
    });
    expect(gatewayClientSenderFields(client)).toEqual({
      sender: {
        id: "alice",
        name: "Suggested by Alice",
        identity: { type: "profile", id: "alice" },
      },
    });
  });

  it("keeps a GitHub-backed mutable alias unattributed until immutable sync completes", () => {
    const client = {
      authenticatedUserId: "released-login@github",
      authenticatedGitHubIdentitySync: async () => ({ profileId: "owner", updatedAt: 1 }),
    } as GatewayClient;

    expect(gatewayClientSenderFields(client)).toEqual({});
    expect(gatewayClientSessionCreator(client)).toBeUndefined();
  });

  it("re-syncs a pending client once from a gated RPC and clears the pending gate (#141615)", async () => {
    let attempts = 0;
    const client = {
      authenticatedUserId: "released-login@github",
    } as GatewayClient;
    // Production's sync attaches the profile as a side effect of resolving.
    client.authenticatedGitHubIdentitySync = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("quota exceeded");
      }
      client.authenticatedUserProfile = { profileId: "owner", updatedAt: 1 };
      return { profileId: "owner", updatedAt: 1 };
    });

    expect(isGatewayClientProfilePending(client)).toBe(true);
    // First gated call retries the sync, gets the transient failure, and
    // answers with the retryable pending shape; the client's retry lands on a
    // healthy backend and the gate clears.
    await expect(refreshPendingGatewayClientProfile(client)).resolves.toBe(true);
    expect(client.authenticatedGitHubIdentitySync).toHaveBeenCalledTimes(1);
    expect(isGatewayClientProfilePending(client)).toBe(true);
    await expect(refreshPendingGatewayClientProfile(client)).resolves.toBe(false);
    expect(client.authenticatedGitHubIdentitySync).toHaveBeenCalledTimes(2);
    expect(isGatewayClientProfilePending(client)).toBe(false);
    // Connected clients without a pending gate never re-enter the sync.
    await expect(refreshPendingGatewayClientProfile(client)).resolves.toBe(false);
    expect(client.authenticatedGitHubIdentitySync).toHaveBeenCalledTimes(2);
  });

  it("stays pending and swallows the sync failure when the identity backend is still down (#141615)", async () => {
    const sync = vi.fn(async () => {
      throw new Error("secondary rate limit");
    });
    const client = {
      authenticatedUserId: "released-login@github",
      authenticatedGitHubIdentitySync: sync,
    } as unknown as GatewayClient;

    await expect(refreshPendingGatewayClientProfile(client)).resolves.toBe(true);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(isGatewayClientProfilePending(client)).toBe(true);
  });
});
