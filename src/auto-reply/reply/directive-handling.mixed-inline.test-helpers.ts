import { onTestFinished, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import { createModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import { createSessionModelCatalogFixture } from "../../agents/test-helpers/session-model-catalog.test-support.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { adoptPersistedSessionSnapshot } from "../../config/sessions/session-snapshot.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import { commitSessionExecutionSelection } from "../../model-picker/apply-session-model-selection.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { MsgContext } from "../templating.js";
import { parseInlineSessionDirectives, type InlineDirectives } from "./directive-handling.parse.js";
import { applyInlineDirectiveOverrides } from "./get-reply-directives-apply.js";

export function createSessionEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return { sessionId: "session-1", updatedAt: 1, ...overrides };
}

export function createSelectedSessionEntry(
  provider: string,
  model: string,
  overrides?: Partial<SessionEntry>,
  runtime = "openclaw",
): SessionEntry {
  const entry = createSessionEntry(overrides);
  commitSessionExecutionSelection(entry, {
    model: { provider, id: model },
    executor: { kind: "harness", id: runtime },
  });
  return entry;
}

export async function createStoredSessionFixture(
  sessionEntry = createSessionEntry(),
  sessionKey = "agent:main:dm:1",
) {
  const state = await createOpenClawTestState({ scenario: "minimal" });
  onTestFinished(() => state.cleanup());
  const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
  const persisted = await replaceSessionEntry({ storePath, sessionKey }, sessionEntry);
  if (!persisted) {
    throw new Error("The initial session fixture was not persisted");
  }
  adoptPersistedSessionSnapshot(sessionEntry, persisted);
  return { sessionEntry, sessionKey, storePath };
}

export async function applyMixedDirectives(params: {
  body: string;
  cfg?: OpenClawConfig;
  ctx?: MsgContext;
  agentDir?: string;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  storePath?: string;
  channel?: string;
  provider?: string;
  model?: string;
  defaultProvider?: string;
  defaultModel?: string;
  allowedModels?: ModelCatalogEntry[];
  selectableModels?: ModelCatalogEntry[];
  modelAliases?: string[];
  aliasIndex?: ModelAliasIndex;
  senderIsOwner?: boolean;
  gatewayClientScopes?: string[];
  directives?: InlineDirectives;
  resolveDefaultThinkingLevel?: Parameters<
    typeof applyInlineDirectiveOverrides
  >[0]["modelState"]["resolveDefaultThinkingLevel"];
}) {
  const inputConfig = params.cfg ?? { commands: { text: true } };
  const provider = params.provider ?? "anthropic";
  const model = params.model ?? "claude-opus-4-6";
  const channel = params.channel ?? "telegram";
  const sessionKey = params.sessionKey ?? "agent:main:dm:1";
  const sessionEntry = params.sessionEntry ?? createSessionEntry();
  const sessionStore = { [sessionKey]: sessionEntry };
  const directives =
    params.directives ??
    parseInlineSessionDirectives(params.body, {
      modelAliases: params.modelAliases,
    });
  const allowedModels = params.allowedModels ?? [];
  const catalog = [
    { provider, id: model, name: "Current model" },
    {
      provider: params.defaultProvider ?? provider,
      id: params.defaultModel ?? model,
      name: "Default model",
    },
    ...allowedModels,
  ].filter(
    (row, index, rows) =>
      rows.findLastIndex((other) => other.provider === row.provider && other.id === row.id) ===
      index,
  );
  const selectable = [...catalog, ...(params.selectableModels ?? [])];
  const providers = Object.fromEntries(
    [...new Set(selectable.map((row) => row.provider))].map((id) => [
      id,
      {
        api: id === "anthropic" ? ("anthropic-messages" as const) : ("openai-responses" as const),
        baseUrl: id === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1",
        ...inputConfig.models?.providers?.[id],
        models: selectable
          .filter((row) => row.provider === id)
          .map((row) => {
            const ownedModel: ModelDefinitionConfig = {
              id: row.id,
              name: row.name,
              reasoning: row.reasoning ?? false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: row.contextWindow ?? 1_000_000,
              maxTokens: 8192,
            };
            if (row.contextTokens !== undefined) {
              ownedModel.contextTokens = row.contextTokens;
            }
            if (row.compat) {
              ownedModel.compat = row.compat;
            }
            Object.assign(
              ownedModel,
              inputConfig.models?.providers?.[id]?.models.find(
                (configured) => configured.id === row.id,
              ),
            );
            return ownedModel;
          }),
      },
    ]),
  );
  const cfg: OpenClawConfig = {
    ...inputConfig,
    models: {
      ...inputConfig.models,
      providers: { ...inputConfig.models?.providers, ...providers },
    },
    agents: {
      ...inputConfig.agents,
      defaults: {
        model: `${params.defaultProvider ?? provider}/${params.defaultModel ?? model}`,
        ...inputConfig.agents?.defaults,
        workspace: "/tmp/workspace",
        models: {
          ...Object.fromEntries(
            selectable.map((row) => [
              `${row.provider}/${row.id}`,
              { agentRuntime: { id: "openclaw" } },
            ]),
          ),
          ...inputConfig.agents?.defaults?.models,
        },
      },
    },
  };
  createSessionModelCatalogFixture().publish({
    config: cfg,
    agentId: "main",
    catalog: { entries: catalog, routeVariants: [] },
    profiles: Object.fromEntries(
      [...new Set(selectable.map((row) => row.provider))].map((id) => [
        `${id}:work`,
        { type: "api_key", provider: id, key: "test-key" },
      ]),
    ),
  });
  const aliasIndex = params.aliasIndex ?? { byAlias: new Map(), byKey: new Map() };
  const modelState: Parameters<typeof applyInlineDirectiveOverrides>[0]["modelState"] = {
    provider,
    model,
    requestedRouteResolution: "resolved",
    sessionExecutionSelection: sessionEntry.executionSelection,
    refreshExecution: async (entry, validateCommit) => {
      const { createModelSelectionState } = await import("./model-selection.js");
      return createModelSelectionState({
        cfg,
        agentId: "main",
        agentCfg: cfg.agents?.defaults,
        sessionEntry: entry,
        sessionStore,
        sessionKey,
        storePath: params.storePath,
        defaultProvider: params.defaultProvider ?? provider,
        defaultModel: params.defaultModel ?? model,
        provider,
        model,
        hasModelDirective: false,
        prepareExecution: true,
        validateCommit,
      });
    },
    modelPolicy: createModelVisibilityPolicy({
      cfg,
      catalog: allowedModels,
      defaultProvider: params.defaultProvider ?? provider,
      defaultModel: params.defaultModel ?? model,
      agentId: "main",
    }),
    allowedModelKeys: new Set(allowedModels.map((entry) => `${entry.provider}/${entry.id}`)),
    allowedModelCatalog: allowedModels,
    policyAliasIndex: aliasIndex,
    resolveThinkingCatalog: async () => allowedModels,
    resolveDefaultThinkingLevel: params.resolveDefaultThinkingLevel ?? (async () => "off"),
    resolveDefaultReasoningLevel: async () => "off",
    needsModelCatalog: false,
  };
  const typing = {
    onReplyStart: async () => {},
    startTypingLoop: async () => {},
    startTypingOnText: async () => {},
    refreshTypingTtl: () => {},
    isActive: () => false,
    markRunComplete: () => {},
    markDispatchIdle: () => {},
    cleanup: vi.fn(),
  };

  const result = await applyInlineDirectiveOverrides({
    ctx: {
      ...params.ctx,
      Body: params.body,
      Provider: channel,
      Surface: channel,
      ...(params.gatewayClientScopes ? { GatewayClientScopes: params.gatewayClientScopes } : {}),
    },
    cfg,
    agentId: "main",
    agentDir: params.agentDir ?? "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    agentCfg: cfg.agents?.defaults ?? {},
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath: params.storePath,
    sessionScope: undefined,
    isGroup: false,
    allowTextCommands: true,
    command: {
      surface: channel,
      channel,
      ownerList: [],
      senderIsOwner: params.senderIsOwner ?? false,
      isAuthorizedSender: true,
      rawBodyNormalized: params.body,
      commandBodyNormalized: params.body,
    },
    directives,
    messageProviderKey: channel,
    elevatedEnabled: true,
    elevatedAllowed: true,
    elevatedFailures: [],
    defaultProvider: params.defaultProvider ?? provider,
    defaultModel: params.defaultModel ?? model,
    aliasIndex,
    provider,
    model,
    modelState,
    initialModelLabel: `${provider}/${model}`,
    formatModelSwitchEvent: (label) => `Model switched to ${label}.`,
    resolvedElevatedLevel: "off",
    defaultActivation: () => "always",
    contextTokens: 8192,
    effectiveModelDirective: directives.rawModelDirective,
    typing,
  });

  return { result, sessionEntry, sessionStore, typing, cfg };
}
