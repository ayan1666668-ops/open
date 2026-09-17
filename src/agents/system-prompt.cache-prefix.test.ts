import type { Model } from "@openclaw/ai";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { buildOpenAICompletionsParams } from "@openclaw/ai/transports";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { composeSystemPromptWithHookContext } from "./embedded-agent-runner/run/attempt-thread-helpers.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

const model: Model<"openai-completions"> = {
  id: "local-model",
  name: "Local model",
  provider: "custom-local",
  api: "openai-completions",
  baseUrl: "https://local.example/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 1024,
};
const tools = [
  { name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) },
];
const coauthor = "When committing, add Co-authored-by: Example User <user@example.com>.";
const hookInstruction = "Always keep the project instruction in its original role.";

function prompt(session: string, workspaceText = "Project instructions.") {
  return buildAgentSystemPrompt({
    workspaceDir: "/tmp/project",
    toolNames: ["read", "message"],
    runtimeInfo: {
      agentId: "main",
      sessionKey: session,
      sessionId: session,
      gitCoauthorPrompt: coauthor,
    },
    contextFiles: [{ path: "/tmp/project/AGENTS.md", content: workspaceText }],
  });
}

describe("system prompt through local Completions", () => {
  it.each([false, true])(
    "preserves the system and tools prefix with developer role %s",
    (reasoning) => {
      const configuredModel = { ...model, reasoning, compat: { supportsDeveloperRole: true } };
      const request = (session: string) =>
        buildOpenAICompletionsParams(
          configuredModel,
          {
            systemPrompt: composeSystemPromptWithHookContext({
              baseSystemPrompt: prompt(session),
              appendSystemContext: hookInstruction,
            }),
            tools,
            messages: [{ role: "user", content: "hello", timestamp: 1 }],
          },
          undefined,
        );
      const first = request("alpha");
      const second = request("beta");

      expect(first.messages[0]).toEqual(second.messages[0]);
      expect(first.tools).toEqual(second.tools);
      expect(first.tools).toHaveLength(1);
      expect(first.messages[0]).toMatchObject({
        role: reasoning ? "developer" : "system",
        content: expect.stringContaining(coauthor),
      });
      expect(first.messages[0]).toMatchObject({
        content: expect.stringContaining(hookInstruction),
      });
      expect(first.messages[0]).toMatchObject({ content: expect.stringContaining("Reasoning=") });
      expect(first.messages[1]).toMatchObject({
        role: "user",
        content: expect.stringContaining("session=alpha"),
      });
      expect(second.messages[1]).toMatchObject({
        role: "user",
        content: expect.stringContaining("session=beta"),
      });
      expect(JSON.stringify(first.messages)).not.toContain("OPENCLAW_CACHE_BOUNDARY");
      expect(JSON.stringify(first.messages)).not.toContain("OPENCLAW-RELOCATABLE-BOUNDARY");
    },
  );

  it.each([
    "<!-- OPENCLAW-RELOCATABLE-BOUNDARY -->",
    "<!-- /OPENCLAW-RELOCATABLE-BOUNDARY -->",
    "<!-- OPENCLAW-RELOCATABLE-BOUNDARY -->\nDocumented example.\n<!-- /OPENCLAW-RELOCATABLE-BOUNDARY -->",
  ])("keeps composed instructions in system content when context contains %s", (literal) => {
    const systemPrompt = composeSystemPromptWithHookContext({
      baseSystemPrompt: prompt("alpha", `Project instructions.\n${literal}\nKeep project policy.`),
      appendSystemContext: hookInstruction,
    });
    const request = buildOpenAICompletionsParams(
      model,
      {
        systemPrompt,
        tools,
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
      },
      undefined,
    );

    expect(request.messages).toHaveLength(2);
    expect(request.messages[1]).toEqual({ role: "user", content: "hello" });
    for (const instruction of [
      "Keep project policy.",
      coauthor,
      hookInstruction,
      "session=alpha",
    ]) {
      expect(request.messages[0]).toMatchObject({
        role: "system",
        content: expect.stringContaining(instruction),
      });
    }
    expect(JSON.stringify(request.messages)).not.toContain("OPENCLAW_CACHE_BOUNDARY");
    expect(JSON.stringify(request.messages)).not.toContain("OPENCLAW-RELOCATABLE-BOUNDARY");
  });
});

describe("system prompt elevated guidance cache prefix", () => {
  type SandboxInfo = NonNullable<Parameters<typeof buildAgentSystemPrompt>[0]["sandboxInfo"]>;
  const build = (elevated: NonNullable<SandboxInfo["elevated"]>) => {
    const rendered = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      contextFiles: [{ path: "AGENTS.md", content: "Stable project instructions." }],
      toolNames: ["exec"],
      sandboxInfo: { enabled: true, elevated },
    });
    expect(rendered).toContain(SYSTEM_PROMPT_CACHE_BOUNDARY);
    const [prefix, suffix] = rendered.split(SYSTEM_PROMPT_CACHE_BOUNDARY);
    return { prefix, suffix };
  };
  const allowed = build({ allowed: true, defaultLevel: "ask", fullAccessAvailable: true });
  const unavailable = build({ allowed: false, defaultLevel: "off", fullAccessAvailable: false });
  const noFull = build({
    allowed: true,
    defaultLevel: "full",
    fullAccessAvailable: false,
    fullAccessBlockedReason: "runtime",
  });

  it("keeps elevated-availability changes below the stable sandbox prefix", () => {
    // Elevated availability is a per-run fact: a normal parent turn and a
    // sessions_yield/announce turn can disagree. It must not perturb the stable
    // prefix before workspace context, or provider-side literal prefix caches
    // re-evaluate the whole prompt.
    expect(unavailable.prefix).toBe(allowed.prefix);
    expect(noFull.prefix).toBe(allowed.prefix);
    expect(allowed.prefix).toContain("Subagents remain sandboxed; no elevated/host access.");
    expect(allowed.prefix).toContain("Stable project instructions.");
    expect(allowed.prefix).not.toContain("/elevated");
    expect(allowed.prefix).not.toContain("Elevated exec is");
  });

  it("retains every elevated guidance line below the boundary", () => {
    expect(allowed.suffix).toContain("Elevated exec is available for this session.");
    expect(allowed.suffix).toContain("User can toggle with /elevated on|off|ask|full.");
    expect(allowed.suffix).toContain("You may also send /elevated on|off|ask|full when needed.");
    expect(unavailable.suffix).toContain("Elevated exec is unavailable for this session.");
    expect(unavailable.suffix).toContain(
      "Do not tell the user to switch to /elevated full in this session.",
    );
    expect(noFull.suffix).toContain("User can toggle with /elevated on|off|ask.");
    expect(noFull.suffix).toContain(
      "Auto-approved /elevated full is unavailable here (runtime constraints).",
    );
    expect(noFull.suffix).not.toContain("You may also send /elevated on|off|ask|full when needed.");
  });
});
