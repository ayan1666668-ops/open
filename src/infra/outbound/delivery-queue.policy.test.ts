// Covers delivery retry policy: permanent-error classification, backoff timing,
// and first-replay eligibility after crashes.
import { describe, expect, it } from "vitest";
import { isProvenDeliveryNotSentError } from "../delivery-recovery.shared.js";
import { recordRetryAttemptErrors } from "../retry-attempt-errors.js";
import { OutboundDeliveryError, PlatformMessageNotDispatchedError } from "./deliver-types.js";

describe("delivery-queue policy", () => {
  describe("isProvenDeliveryNotSentError", () => {
    const createMarker = () =>
      new PlatformMessageNotDispatchedError("upload stopped before finalization", {
        cause: new Error("request timed out"),
      });

    it("accepts the channel-owned marker", () => {
      expect(isProvenDeliveryNotSentError(createMarker())).toBe(true);
    });

    it("rejects a platform error that copies only the marker code", () => {
      const forged = Object.assign(new Error("remote platform failure"), {
        code: createMarker().code,
      });
      expect(isProvenDeliveryNotSentError(forged)).toBe(false);
    });

    it.each(["connection reset after write", null])(
      "rejects a marked aggregate with an unproven %s branch",
      (unprovenBranch) => {
        expect(
          isProvenDeliveryNotSentError(new AggregateError([createMarker(), unprovenBranch])),
        ).toBe(false);
      },
    );

    it("rejects a marker that follows an ambiguous retry attempt", () => {
      const marker = createMarker();
      recordRetryAttemptErrors(marker, [new Error("connection reset after write"), marker]);
      expect(isProvenDeliveryNotSentError(marker)).toBe(false);
    });

    it("treats a connect-stage ECONNRESET as proven not sent (replayable)", () => {
      const connectReset = Object.assign(new Error("connect ECONNRESET"), {
        code: "ECONNRESET",
        syscall: "connect",
      });
      expect(isProvenDeliveryNotSentError(connectReset)).toBe(true);
    });

    it.each([
      ["read", "read ECONNRESET"],
      ["write", "write ECONNRESET"],
    ])("keeps a post-connect %s ECONNRESET ambiguous (not replayable)", (_syscall, message) => {
      const postConnectReset = Object.assign(new Error(message), {
        code: "ECONNRESET",
        syscall: _syscall,
      });
      expect(isProvenDeliveryNotSentError(postConnectReset)).toBe(false);
    });

    it("keeps a connect ECONNRESET ambiguous when the platform send already started", () => {
      const connectReset = Object.assign(new Error("connect ECONNRESET"), {
        code: "ECONNRESET",
        syscall: "connect",
      });
      const dispatched = new OutboundDeliveryError("send failed", {
        cause: connectReset,
        payloadOutcomes: [
          {
            index: 0,
            status: "failed" as const,
            error: connectReset,
            sentBeforeError: true,
            stage: "send" as const,
          },
        ],
      });
      expect(isProvenDeliveryNotSentError(dispatched)).toBe(false);
    });
  });
});
