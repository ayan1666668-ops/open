// Line tests cover the postback encoding for approval decision controls.

import { buildApprovalResolutionRef } from "openclaw/plugin-sdk/approval-reference-runtime";
import { describe, expect, it } from "vitest";
import { LINE_ACTION_DATA_LIMIT } from "./actions.js";
import {
  buildLineApprovalPostbackData,
  hasLineApprovalPostbackData,
  parseLineApprovalPostbackData,
  type LineApprovalPostback,
} from "./approval-postback.js";

const approval = (overrides: Partial<LineApprovalPostback> = {}): LineApprovalPostback => ({
  type: "approval",
  approvalId: "6f4a1b2c-0d3e-4f5a-8b9c-0d1e2f3a4b5c",
  approvalKind: "exec",
  decision: "allow-once",
  ...overrides,
});

describe("LINE approval postback data", () => {
  it("round-trips every decision the control can offer", () => {
    for (const decision of ["allow-once", "allow-always", "deny"] as const) {
      for (const approvalKind of ["exec", "plugin", "system-agent"] as const) {
        const action = approval({ approvalKind, decision });
        const data = buildLineApprovalPostbackData(action);
        expect(data).toBeDefined();
        expect(parseLineApprovalPostbackData(data ?? "")).toEqual(action);
      }
    }
  });

  it("keeps the exact approval id when it fits the action data ceiling", () => {
    const data = buildLineApprovalPostbackData(approval());
    expect(parseLineApprovalPostbackData(data ?? "")?.approvalId).toBe(approval().approvalId);
    expect((data ?? "").length).toBeLessThanOrEqual(LINE_ACTION_DATA_LIMIT);
  });

  it("falls back to a digest locator instead of dropping an oversized id", () => {
    const approvalId = "x".repeat(LINE_ACTION_DATA_LIMIT + 1);
    const action = approval({ approvalId });
    const data = buildLineApprovalPostbackData(action);
    expect(data).toBeDefined();
    expect((data ?? "").length).toBeLessThanOrEqual(LINE_ACTION_DATA_LIMIT);
    expect(parseLineApprovalPostbackData(data ?? "")?.approvalId).toBe(
      buildApprovalResolutionRef({ approvalId, approvalKind: "exec" }),
    );
  });

  it("reserves the namespace for data it cannot read", () => {
    // bot-handlers must consume a malformed approval postback instead of letting
    // its raw data reach the agent as a turn.
    const malformed = "line.approval=&line.approvalKind=exec&line.decision=allow-once";
    expect(hasLineApprovalPostbackData(malformed)).toBe(true);
    expect(parseLineApprovalPostbackData(malformed)).toBeUndefined();
  });

  it("ignores postback data from another control", () => {
    const questionData = "line.question=q-1&line.option=0";
    expect(hasLineApprovalPostbackData(questionData)).toBe(false);
    expect(parseLineApprovalPostbackData(questionData)).toBeUndefined();
  });

  it("rejects an unknown kind or decision", () => {
    for (const data of [
      "line.approval=a1&line.approvalKind=elevated&line.decision=allow-once",
      "line.approval=a1&line.approvalKind=exec&line.decision=allow-forever",
      "line.approval=a1&line.approvalKind=exec",
    ]) {
      expect(hasLineApprovalPostbackData(data)).toBe(true);
      expect(parseLineApprovalPostbackData(data)).toBeUndefined();
    }
  });
});
