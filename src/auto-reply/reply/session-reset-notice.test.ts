import { describe, expect, it } from "vitest";
import { buildAutomaticSessionResetNoticePayload } from "./session-reset-notice.js";

describe("buildAutomaticSessionResetNoticePayload", () => {
  it.each([
    ["idle", "🧭 Started a new session after the configured idle timeout."],
    ["daily", "🧭 Started a new session at the configured daily reset boundary."],
  ] as const)("formats the %s rollover notice", (reason, text) => {
    expect(
      buildAutomaticSessionResetNoticePayload({ reason, payloads: [{ text: "reply" }] }),
    ).toEqual({ text });
  });

  it("does not turn a silent or error-only result into a visible reply", () => {
    expect(
      buildAutomaticSessionResetNoticePayload({ reason: "idle", payloads: [] }),
    ).toBeUndefined();
    expect(
      buildAutomaticSessionResetNoticePayload({
        reason: "daily",
        payloads: [{ text: "failed", isError: true }],
      }),
    ).toBeUndefined();
  });
});
