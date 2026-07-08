import type { Api, Model } from "@mariozechner/pi-ai";
import type { AgentCompactionIdentifierPolicy } from "../../config/types.agent-defaults.js";
import { createSessionManagerRuntimeRegistry } from "./session-manager-runtime-registry.js";

export type CompactionSafeguardRuntimeValue = {
  maxHistoryShare?: number;
  contextWindowTokens?: number;
  identifierPolicy?: AgentCompactionIdentifierPolicy;
  identifierInstructions?: string;
  /**
   * Model to use for compaction summarization.
   * Passed through runtime because `ctx.model` is undefined in the compact.ts workflow
   * (extensionRunner.initialize() is never called in that path).
   */
  model?: Model<Api>;
  /**
   * Workspace dir for reading AGENTS.md summary context. Passed explicitly
   * because process.cwd() is not workspace-scoped (lanes run concurrently).
   */
  workspaceDir?: string;
};

const registry = createSessionManagerRuntimeRegistry<CompactionSafeguardRuntimeValue>();

export const setCompactionSafeguardRuntime = registry.set;

export const getCompactionSafeguardRuntime = registry.get;
