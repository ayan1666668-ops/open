import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGuardedResponder } from "./respond-guard.js";

describe("createGuardedResponder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes the first response through", () => {
    const respond = vi.fn();
    const guarded = createGuardedResponder({ respond, method: "health" });
    guarded(true, { ok: 1 });
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(true, { ok: 1 }, undefined, undefined);
  });

  it("drops duplicate responses and reports them", () => {
    const respond = vi.fn();
    const onDuplicate = vi.fn();
    const guarded = createGuardedResponder({ respond, method: "health", onDuplicate });
    guarded(true, "first");
    guarded(false, "second");
    expect(respond).toHaveBeenCalledTimes(1);
    expect(onDuplicate).toHaveBeenCalledTimes(1);
  });

  it("warns when the request is still pending after warnAfterMs", () => {
    const respond = vi.fn();
    const onWarn = vi.fn();
    createGuardedResponder({
      respond,
      method: "chat.send",
      warnAfterMs: 1000,
      timeoutAfterMs: 5000,
      onWarn,
    });
    vi.advanceTimersByTime(1001);
    expect(onWarn).toHaveBeenCalledWith(1000);
    expect(respond).not.toHaveBeenCalled();
  });

  it("does not warn when a response arrived in time", () => {
    const respond = vi.fn();
    const onWarn = vi.fn();
    const guarded = createGuardedResponder({
      respond,
      method: "chat.send",
      warnAfterMs: 1000,
      timeoutAfterMs: 5000,
      onWarn,
    });
    guarded(true);
    vi.advanceTimersByTime(10_000);
    expect(onWarn).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("fails the request with a retryable UNAVAILABLE error at the hard timeout", () => {
    const respond = vi.fn();
    createGuardedResponder({
      respond,
      method: "agent.wait",
      warnAfterMs: 1000,
      timeoutAfterMs: 5000,
    });
    vi.advanceTimersByTime(5001);
    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, payload, error] = respond.mock.calls[0];
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error).toMatchObject({
      code: "UNAVAILABLE",
      retryable: true,
    });
    expect(String(error?.message)).toContain("agent.wait");
  });

  it("ignores late responses after the timeout already fired", () => {
    const respond = vi.fn();
    const onDuplicate = vi.fn();
    const guarded = createGuardedResponder({
      respond,
      method: "agent.wait",
      warnAfterMs: 1000,
      timeoutAfterMs: 5000,
      onDuplicate,
    });
    vi.advanceTimersByTime(5001);
    guarded(true, "too late");
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0][0]).toBe(false);
    expect(onDuplicate).toHaveBeenCalledTimes(1);
  });
});
