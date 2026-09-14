import type { CodexAppServerAuthHandoff } from "./auth-bridge.js";
import type { CodexAppServerAuthProfileLookup } from "./auth-profile.js";
import type { CodexDynamicToolSpec, CodexServiceTier, JsonObject } from "./protocol.js";

export type ClientRuntimeContext = CodexAppServerAuthProfileLookup & {
  authMode?: "prepared-api-key" | "profile";
  onAuthRefreshFailure?: () => void;
};

export type ClientRuntime = {
  context: ClientRuntimeContext;
  authHandoff?: CodexAppServerAuthHandoff;
  closed: boolean;
  retainedThreads: Map<string, RetainedLiveThread>;
  claimedThreads: Map<string, symbol>;
  releasingThreads: Map<string, ThreadReleaseTransition>;
  protectedThreads: Map<string, number>;
  sessionMetadata: Map<string, { sessionsRoot: string; rolloutPath: string; metadata: JsonObject }>;
  workspaceReferences: Map<string, { digest?: string; needsReintroduction: boolean }>;
  ephemeralCreations: Map<
    string,
    { hookInstallation: string; dynamicTools: CodexDynamicToolSpec[] }
  >;
  evictionTimer?: ReturnType<typeof setTimeout>;
};

export type RetainedLiveThread = {
  configFingerprint?: string;
  ephemeralPolicy?: string;
  serviceTier?: CodexServiceTier | null;
  expiresAt: number;
  release: (threadId: string, assertCurrent?: () => void) => Promise<void>;
};

export type ThreadReleaseTransition = {
  completion: Promise<void>;
  physicalRelease?: Promise<void>;
  invalidated?: boolean;
};
