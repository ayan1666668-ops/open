import { expect } from "vitest";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { createSessionModelCatalogFixture } from "../agents/test-helpers/session-model-catalog.test-support.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { projectSessionsPatchEntry } from "./sessions-patch.js";

const preparedCatalog = createSessionModelCatalogFixture();

export async function applySessionsPatchToStore(
  params: Omit<
    Parameters<typeof projectSessionsPatchEntry>[0],
    "existingEntry" | "isLabelInUse"
  > & {
    store: Record<string, SessionEntry>;
    loadGatewayModelCatalog?: () => Promise<ModelCatalogEntry[]>;
    profiles?: AuthProfileStore["profiles"];
  },
) {
  const load = params.loadGatewayModelCatalog;
  const projected = await projectSessionsPatchEntry({
    ...params,
    loadGatewayModelCatalogSnapshot: load
      ? async () => {
          const entries = await load();
          const agentId =
            params.agentId ??
            resolveSessionAgentId({ sessionKey: params.storeKey, config: params.cfg });
          const configured = resolveDefaultModelForAgent({ cfg: params.cfg, agentId });
          const providers = new Set([...entries.map((row) => row.provider), configured.provider]);
          const profiles: AuthProfileStore["profiles"] = Object.fromEntries(
            [...providers].map((provider) => [
              provider + ":default",
              { type: "api_key" as const, provider, key: "synthetic-credential" },
            ]),
          );
          for (const [id, provider] of [
            ["anthropic:default", "anthropic"],
            ["openai:good", "openai"],
            ["byteplus:work", "byteplus"],
            ["work", "anthropic"],
            ["myprofile", "anthropic"],
            ["oldprofile", "anthropic"],
            ["newprofile", "anthropic"],
            ["openai:user@example.com", "anthropic"],
          ] as const) {
            profiles[id] = { type: "api_key", provider, key: "synthetic-credential" };
          }
          return preparedCatalog.publish({
            config: params.cfg,
            agentId,
            catalog: { entries, routeVariants: entries },
            profiles: { ...profiles, ...params.profiles },
            plugins: params.providerAuthMetadataSnapshot?.plugins,
          });
        }
      : undefined,
    existingEntry: params.store[params.storeKey],
    isLabelInUse: (label) =>
      Object.entries(params.store).some(
        ([sessionKey, entry]) => sessionKey !== params.storeKey && entry.label === label,
      ),
  });
  if (projected.ok) {
    params.store[params.storeKey] = projected.entry;
  }
  return projected;
}

export function catalogEntry(ref: string, name?: string) {
  const separator = ref.indexOf("/");
  if (separator < 0) {
    throw new Error(`model ref must include provider: ${ref}`);
  }
  const id = ref.slice(separator + 1);
  return {
    provider: ref.slice(0, separator),
    id,
    name: name ?? id,
  };
}

export function loadCatalog(...refs: string[]): () => Promise<ModelCatalogEntry[]> {
  return async () => refs.map((ref) => catalogEntry(ref));
}

export function expectModelSelection(entry: SessionEntry, provider: string, model: string) {
  expect(entry.executionSelection).toMatchObject({
    state: "accepted",
    selection: { model: { provider, id: model } },
  });
}

export function expectAuthOverride(
  entry: SessionEntry,
  expected: {
    profile: string | undefined;
    source?: string;
    compactionCount?: number;
  },
) {
  expect(entry.authProfileOverride).toBe(expected.profile);
  if (expected.profile === undefined) {
    expect(entry.authProfileOverrideSource).toBeUndefined();
    expect(entry.authProfileOverrideCompactionCount).toBeUndefined();
    return;
  }
  expect(entry.authProfileOverrideSource).toBe(expected.source ?? "user");
  if (expected.compactionCount === undefined) {
    expect(entry.authProfileOverrideCompactionCount).toBeUndefined();
  } else {
    expect(entry.authProfileOverrideCompactionCount).toBe(expected.compactionCount);
  }
}
