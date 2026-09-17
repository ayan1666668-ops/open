import { describe, expect, it } from "vitest";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import {
  clearCompactionQualityRejections,
  recordCompactionQualityRejection,
} from "./compaction-quality-rejections.js";

describe("compaction quality rejection identity", () => {
  it.each(["agentId", "sessionId", "sessionKey", "storePath"] as const)(
    "does not share notices across %s while surviving reopened target objects",
    (field) => {
      const target: SessionTranscriptRuntimeTarget = {
        agentId: "main",
        sessionId: `identity-${field}`,
        sessionKey: `agent:main:identity-${field}`,
        storePath: "/tmp/compaction-identity/sessions.json",
      };
      const other = { ...target, [field]: `${target[field]}-other` };
      expect(recordCompactionQualityRejection(target, ["missing_section"]).notify).toBe(false);
      expect(recordCompactionQualityRejection({ ...target }, ["duplicate_section"]).notify).toBe(
        false,
      );
      expect(recordCompactionQualityRejection(other, ["missing_identifiers"]).notify).toBe(false);
      const third = recordCompactionQualityRejection({ ...target }, ["missing_section"]);
      expect(third.notify).toBe(true);
      expect(third.notice).toContain("missing_section, duplicate_section");
      expect(third.notice).not.toContain("missing_identifiers");
      expect(third.log).toBe(true);
      const pending = recordCompactionQualityRejection(target, ["missing_section"]);
      expect(pending.notify).toBe(true);
      expect(pending.log).toBe(false);
      pending.acknowledgeNotice?.();
      expect(recordCompactionQualityRejection(target, ["missing_section"]).notify).toBe(false);
      clearCompactionQualityRejections(target);
      recordCompactionQualityRejection(target, ["missing_section"]);
      third.acknowledgeNotice?.();
      recordCompactionQualityRejection(target, ["missing_section"]);
      expect(recordCompactionQualityRejection(target, ["missing_section"]).notify).toBe(true);
      clearCompactionQualityRejections(target);
      clearCompactionQualityRejections(other);
    },
  );

  it("bounds inactive session tracking and does not suggest overriding locked models", () => {
    const target = (index: number): SessionTranscriptRuntimeTarget => ({
      agentId: "main",
      sessionId: `bounded-${index}`,
      sessionKey: `agent:main:bounded-${index}`,
      storePath: "/tmp/compaction-bounds/sessions.json",
    });
    for (let index = 0; index <= 1024; index += 1) {
      recordCompactionQualityRejection(target(index), ["missing_section"]);
    }
    recordCompactionQualityRejection(target(0), ["missing_section"]);
    expect(recordCompactionQualityRejection(target(0), ["missing_section"]).notify).toBe(false);
    const third = recordCompactionQualityRejection(target(0), ["duplicate_section"], true);
    expect(third.notify).toBe(true);
    expect(third.notice).toContain("Retry with /compact.");
    expect(third.notice).not.toContain("compaction.model");
    for (let index = 0; index <= 1024; index += 1) {
      clearCompactionQualityRejections(target(index));
    }
  });
});
