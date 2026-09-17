import { describe, expect, it } from "vitest";
import { resolveReplyFailoverFacts } from "../../auto-reply/reply/agent-runner-failure-reply.js";
import { formatUserFacingAssistantErrorText } from "../embedded-agent-helpers/error-text.js";
import { resolveAuthProfileFailureReason } from "../embedded-agent-runner/run/auth-profile-failure-policy.js";
import { SessionManager } from "../sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { classifyFailoverReason } from "./classify.js";

function thrownTranscriptValidationMessage(): string {
  try {
    SessionManager.inMemory("/tmp").appendModelChange("", "");
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
  }
  throw new Error("expected SessionManager.appendModelChange to reject the invalid entry");
}

describe("Gateway transcript validation failure classification", () => {
  it("does not treat the live SessionManager validator error as provider session expiry", () => {
    const message = thrownTranscriptValidationMessage();
    expect(message).toMatch(/^Invalid session transcript entry:/);
    expect(classifyFailoverReason(message, { provider: "openrouter" })).toBe("format");
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: classifyFailoverReason(message),
        providerStarted: false,
        policy: "shared",
      }),
    ).toBeNull();
    expect(
      formatUserFacingAssistantErrorText(
        makeAssistantMessageFixture({
          provider: "openrouter",
          model: "gemini-2.5-flash",
          errorMessage: message,
        }),
      ),
    ).toBe(
      "LLM request failed: the Gateway rejected a session transcript entry. Compact or reset this session and try again.",
    );
    expect(resolveReplyFailoverFacts(new Error(message), message).reason).toBe("format");
  });

  it("still cools credentials and names provider session expiry for genuine invalid-session copy", () => {
    const message = "invalid session";
    expect(classifyFailoverReason(message)).toBe("session_expired");
    expect(
      resolveAuthProfileFailureReason({
        failoverReason: classifyFailoverReason(message),
        providerStarted: true,
        policy: "shared",
      }),
    ).toBe("session_expired");
    expect(
      formatUserFacingAssistantErrorText(
        makeAssistantMessageFixture({
          provider: "openrouter",
          model: "gemini-2.5-flash",
          errorMessage: message,
        }),
      ),
    ).toBe("⚠️ openrouter/gemini-2.5-flash request failed (provider session expired).");
  });
});
