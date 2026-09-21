import { defineCodexBuildState } from "../build-state.js";
import type { CodexAppServerAuthHandoff } from "./auth-bridge.js";
import type { CodexAppServerAuthProfileLookup } from "./auth-profile.js";
import type { ThreadOwnershipState, ThreadOwnerToken } from "./client-thread-owner.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexDynamicToolSpec, CodexServiceTier, JsonObject } from "./protocol.js";

export type ClientRuntimeContext = CodexAppServerAuthProfileLookup & {
  authMode?: "prepared-api-key" | "profile";
  onAuthRefreshFailure?: () => void;
};

export type ClientRuntime = ThreadOwnershipState & {
  context: ClientRuntimeContext;
  authHandoff?: CodexAppServerAuthHandoff;
  sessionMetadata: Map<string, { sessionsRoot: string; rolloutPath: string; metadata: JsonObject }>;
  workspaceReferences: Map<string, { digest?: string; needsReintroduction: boolean }>;
  ephemeralCreations: Map<
    string,
    { hookInstallation: string; dynamicTools: CodexDynamicToolSpec[] }
  >;
  evictionTimer?: ReturnType<typeof setTimeout>;
};

export type CodexAppServerLiveThreadOwnership = {
  assertCurrent: () => void;
  configFingerprint?: string;
  /** Ephemeral configuration is creation-owned and cannot be refreshed or cold-resumed. */
  ephemeralPolicy?: string;
  serviceTier?: CodexServiceTier | null;
  /** Releases this active claim or the exact idle record it published. */
  release: (threadId: string, assertCurrent?: () => void) => Promise<void>;
  /** Forgets this local owner after native shutdown, without unsubscribing a successor. */
  forget: () => void;
};

// Same-build plugin generations share physical clients. Their runtime facts and
// release brands must follow that same owner or reload loses live subscriptions.
export const { configuredClients, physicalThreadReleases, claimedThreadReleaseTokens } =
  defineCodexBuildState("openclaw.codexAppServerClientRuntime", () => ({
    configuredClients: new WeakMap<CodexAppServerClient, ClientRuntime>(),
    physicalThreadReleases: new WeakMap<
      CodexAppServerLiveThreadOwnership["release"],
      CodexAppServerLiveThreadOwnership["release"]
    >(),
    claimedThreadReleaseTokens: new WeakMap<
      CodexAppServerLiveThreadOwnership["release"],
      ThreadOwnerToken
    >(),
  }))();

/** Only an initialized, still-open physical client can own retained native subscriptions. */
export function isCodexAppServerClientRuntimeLive(client: CodexAppServerClient): boolean {
  const runtime = configuredClients.get(client);
  return runtime !== undefined && !runtime.closed;
}

/** Only acknowledged native creation records this fact; refused changes leave it intact. */
export function recordCodexEphemeralThreadCreation(
  client: CodexAppServerClient,
  threadId: string,
  creation: { hookInstallation: string; dynamicTools: CodexDynamicToolSpec[] },
): void {
  const runtime = configuredClients.get(client);
  if (!runtime || runtime.closed) {
    throw new Error("Codex ephemeral creation requires a live physical client");
  }
  runtime.ephemeralCreations.set(threadId, structuredClone(creation));
}

export function readCodexNativeHookInstallation(
  client: CodexAppServerClient,
  threadId: string,
): string | undefined {
  const runtime = configuredClients.get(client);
  return runtime && !runtime.closed
    ? runtime.ephemeralCreations.get(threadId)?.hookInstallation
    : undefined;
}

/** Ephemeral threads have no rollout; their acknowledged declarations share the live owner. */
export function readCodexEphemeralThreadCatalog(
  client: CodexAppServerClient,
  threadId: string,
): CodexDynamicToolSpec[] | undefined {
  const runtime = configuredClients.get(client);
  const creation =
    runtime && !runtime.closed ? runtime.ephemeralCreations.get(threadId) : undefined;
  return creation ? structuredClone(creation.dynamicTools) : undefined;
}
