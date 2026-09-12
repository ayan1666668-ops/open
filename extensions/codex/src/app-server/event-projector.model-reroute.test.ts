import { describe, expect, it, vi } from "vitest";
import {
  buildEmptyToolTelemetry,
  createParams,
  createProjector,
  forCurrentTurn,
  registerCodexEventProjectorTestLifecycle,
  turnCompleted,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector model reroute projection", () => {
  it("publishes the current-turn model and projects it onto the terminal assistant", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });
    await projector.handleNotification(
      forCurrentTurn("model/rerouted", {
        fromModel: "gpt-5.4-codex",
        toModel: "gpt-5.4-codex-mini",
        reason: "highRiskCyberActivity",
      }),
    );
    await projector.handleNotification(
      turnCompleted([{ type: "agentMessage", id: "msg-rerouted", text: "done" }]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.currentAttemptAssistant?.responseModel).toBe("gpt-5.4-codex-mini");
    expect(result.lastAssistant?.responseModel).toBe("gpt-5.4-codex-mini");
    expect(result).toMatchObject({ terminalTurnId: "turn-1" });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "model",
        provider: "openai",
        model: "gpt-5.4-codex-mini",
      },
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "fallback",
      data: {
        fromModel: "gpt-5.4-codex",
        toModel: "gpt-5.4-codex-mini",
        reason: "highRiskCyberActivity",
      },
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "notice",
      data: {
        phase: "provider_policy",
        category: "cyber",
        state: "fallback",
        provider: "openai",
        model: "gpt-5.4-codex",
        fallbackModel: "gpt-5.4-codex-mini",
      },
    });
  });
});
