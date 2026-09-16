import { isDeepStrictEqual } from "node:util";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  encodeSessionExecutionSelection,
  resolveSessionExecutionRepairPair,
} from "./execution-selection-codec.js";
import { resolveConfiguredExecutionSelection } from "./execution-selection-configured.js";
import { executionSelectionCodecMetadata } from "./execution-selection-state.js";
import type { ModelExecutionSelection } from "./execution-selection.js";

/** Existing Doctor repairs use configured/static identity; readiness belongs to the next turn. */
export function repairSessionExecutionSelection(params: {
  entry: SessionEntry;
  cfg?: OpenClawConfig;
  agentId?: string;
  model?: ModelExecutionSelection["model"];
  executor?: ModelExecutionSelection["executor"];
  runtimeMigration?: (id: string) => ModelExecutionSelection["executor"] | undefined;
  reset?: boolean;
  preserveAuthProfileOverride?: boolean;
}):
  | { status: "unchanged" | "unresolved" }
  | { status: "repaired"; selection: ModelExecutionSelection } {
  if (params.entry.modelSelectionLocked || params.entry.acp) {
    return { status: "unchanged" };
  }
  const configured =
    params.cfg && params.agentId
      ? resolveDefaultModelForAgent({
          cfg: params.cfg,
          agentId: params.agentId,
          allowPluginNormalization: false,
        })
      : undefined;
  const model =
    params.model ??
    (configured ? { provider: configured.provider, id: configured.model } : undefined);
  if (!model) {
    return { status: "unresolved" };
  }
  const metadata = executionSelectionCodecMetadata(params.cfg, configured?.provider);
  const configuredSelection =
    params.cfg && params.agentId
      ? resolveConfiguredExecutionSelection({
          cfg: params.cfg,
          agentId: params.agentId,
          model,
          metadata,
        })
      : undefined;
  const selection = resolveSessionExecutionRepairPair({
    entry: params.entry,
    model,
    executor: params.executor ?? configuredSelection?.executor,
    metadata,
    runtimeMigration: params.runtimeMigration,
  });
  if (!selection) {
    return { status: "unresolved" };
  }
  const before = structuredClone(params.entry);
  encodeSessionExecutionSelection(
    params.entry,
    selection,
    params.reset ? { kind: "reset" } : { kind: "inherit", entry: before },
  );
  if (params.preserveAuthProfileOverride === false) {
    delete params.entry.authProfileOverride;
    delete params.entry.authProfileOverrideSource;
    delete params.entry.authProfileOverrideCompactionCount;
  }
  if (isDeepStrictEqual(before, params.entry)) {
    return { status: "unchanged" };
  }
  params.entry.updatedAt = Date.now();
  return { status: "repaired", selection };
}
