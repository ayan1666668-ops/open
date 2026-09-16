// Vllm plugin module implements thinking policy behavior.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-metadata";

export type VllmQwenThinkingFormat = "chat-template" | "top-level";

const VLLM_BINARY_THINKING_PROFILE = {
  levels: [{ id: "off" }, { id: "low", label: "on" }],
  defaultLevel: "off",
} satisfies ProviderThinkingProfile;

type VllmThinkingLevelId = ProviderThinkingProfile["levels"][number]["id"];

/** Effort ladder a Qwen endpoint can accept as `reasoning_effort`, weakest first. */
const VLLM_QWEN_EFFORT_LADDER: readonly VllmThinkingLevelId[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function normalizeVllmEffortLevel(value: unknown): VllmThinkingLevelId | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const collapsed = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  const level = collapsed === "extrahigh" ? "xhigh" : collapsed;
  return VLLM_QWEN_EFFORT_LADDER.find((candidate) => candidate === level);
}

/**
 * Qwen chat-template thinking is an on/off flag, but a vLLM reasoning parser
 * can also honor `reasoning_effort`. A model row that lists the efforts its
 * server accepts opts into a graded ladder instead of the binary profile.
 */
export function resolveVllmQwenEffortLevels(
  compat?: ProviderDefaultThinkingPolicyContext["compat"],
): VllmThinkingLevelId[] | undefined {
  const efforts = compat?.supportedReasoningEfforts;
  if (!Array.isArray(efforts) || efforts.length === 0) {
    return undefined;
  }
  const declared = new Set(
    efforts.map(normalizeVllmEffortLevel).filter((level) => level !== undefined),
  );
  const levels = VLLM_QWEN_EFFORT_LADDER.filter((level) => declared.has(level));
  return levels.length > 0 ? levels : undefined;
}

function normalizeVllmQwenThinkingFormat(value: unknown): VllmQwenThinkingFormat | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (
    normalized === "chat-template" ||
    normalized === "chat-template-kwargs" ||
    normalized === "chat-template-kwarg" ||
    normalized === "chat-template-arguments" ||
    normalized === "qwen-chat-template"
  ) {
    return "chat-template";
  }
  if (
    normalized === "top-level" ||
    normalized === "enable-thinking" ||
    normalized === "request-body" ||
    normalized === "qwen"
  ) {
    return "top-level";
  }
  return undefined;
}

export function resolveVllmQwenThinkingFormatFromCompat(
  compat?: ProviderDefaultThinkingPolicyContext["compat"],
): VllmQwenThinkingFormat | undefined {
  return normalizeVllmQwenThinkingFormat(compat?.thinkingFormat);
}

function isVllmNemotronThinkingModel(modelId: string): boolean {
  return /\bnemotron-3(?:[-_](?:nano|super|ultra))?\b/i.test(modelId);
}

export function resolveThinkingProfile(
  ctx: ProviderDefaultThinkingPolicyContext,
): ProviderThinkingProfile | null {
  if (normalizeProviderId(ctx.provider) !== "vllm") {
    return null;
  }
  if (ctx.reasoning === false) {
    return null;
  }
  const qwenFormat = resolveVllmQwenThinkingFormatFromCompat(ctx.compat);
  if (qwenFormat) {
    const effortLevels = resolveVllmQwenEffortLevels(ctx.compat);
    if (effortLevels) {
      return {
        levels: [{ id: "off" }, ...effortLevels.map((id) => ({ id }))],
        defaultLevel: "off",
      };
    }
    return VLLM_BINARY_THINKING_PROFILE;
  }
  if (ctx.reasoning === true && isVllmNemotronThinkingModel(ctx.modelId)) {
    return VLLM_BINARY_THINKING_PROFILE;
  }
  return null;
}
