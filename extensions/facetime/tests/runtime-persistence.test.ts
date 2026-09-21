import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  createRuntime,
  createTalkDriver,
  incomingCall,
  mocks,
  pendingDialCancellationResult,
  pendingDialCarrierResult,
  pendingDialState,
  resetRuntimeTestState,
} from "./runtime.test-support.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function emptyState() {
  return createPluginStateKeyedStoreForTests<unknown>("facetime", {
    namespace: "pending-dial",
    maxEntries: 1,
    overflowPolicy: "reject-new",
  });
}

function suspendNextWrite(state: ReturnType<typeof emptyState>) {
  const entered = deferred();
  const release = deferred();
  const register = state.register.bind(state);
  vi.spyOn(state, "register").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    await register(...args);
  });
  return { entered: entered.promise, release: release.resolve };
}

function outgoingCall(dialID: string, status: number) {
  const event = incomingCall(status);
  return {
    ...event,
    data: {
      ...event.data,
      dial_id: dialID,
      call_uuid: "outbound-call",
      is_outgoing: true,
    },
  };
}

describe("FaceTime runtime asynchronous persistence", () => {
  beforeEach(async () => {
    await resetRuntimeTestState();
    mocks.helper.cancelOutgoingCall.mockResolvedValue(pendingDialCancellationResult());
    mocks.helper.findOutgoingCall.mockResolvedValue(pendingDialCarrierResult());
  });

  it("waits for the initial durable pending record before dispatching the helper dial", async () => {
    const state = emptyState();
    const runtime = await createRuntime(state);
    const hostSql = observeHostDataSql();
    const write = suspendNextWrite(state);
    mocks.helper.startCall.mockImplementationOnce(async (_request: unknown, dialID: string) => {
      expect(await state.lookup("active")).toMatchObject({ dialID, delivery: "in-flight" });
      return {
        dial_id: dialID,
        call_uuid: "outbound-call",
        muted: true,
        is_uplink_muted: true,
        transport: incomingCall().data.transport,
      };
    });
    const dialing = runtime.dial({ handle: "owner@example.com" });
    try {
      await write.entered;
      expect(mocks.helper.startCall).not.toHaveBeenCalled();
      expect(await state.lookup("active")).toBeUndefined();

      write.release();
      const result = await dialing;
      expect(mocks.helper.startCall).toHaveBeenCalledOnce();
      await mocks.helperParams?.onMessage(outgoingCall(result.dialID, 6));
      expect(await state.lookup("active")).toBeUndefined();
      for (const call of hostSql.calls) {
        expect(call).not.toHaveBeenCalled();
      }
    } finally {
      hostSql.restore();
      write.release();
      await dialing.catch(() => undefined);
      await runtime.stop();
    }
  });

  it("never dispatches a helper dial when its initial persistence fails", async () => {
    const state = emptyState();
    const runtime = await createRuntime(state);
    const failure = new Error("pending dial publication failed");
    vi.spyOn(state, "register").mockRejectedValueOnce(failure);
    try {
      await expect(runtime.dial({ handle: "owner@example.com" })).rejects.toBe(failure);

      expect(mocks.helper.startCall).not.toHaveBeenCalled();
      expect(await state.lookup("active")).toBeUndefined();
    } finally {
      await runtime.stop();
    }
  });

  it("does not promote or resurrect a dial ended while an earlier event save is suspended", async () => {
    const state = await pendingDialState();
    const runtime = await createRuntime(state);
    const talk = createTalkDriver({});
    mocks.startTalk.mockResolvedValue(talk);
    const write = suspendNextWrite(state);
    const active = mocks.helperParams?.onMessage(outgoingCall("approved-dial", 1));
    let ended: void | Promise<void>;
    try {
      await write.entered;
      ended = mocks.helperParams?.onMessage(outgoingCall("approved-dial", 6));
      expect(mocks.startTalk).not.toHaveBeenCalled();

      write.release();
      await Promise.all([active, ended]);

      expect(mocks.startTalk).not.toHaveBeenCalled();
      expect(mocks.helper.setMuted).not.toHaveBeenCalled();
      expect((await runtime.status()).calls).toEqual([]);
      expect((await runtime.status()).outboundCallPending).toBeUndefined();
      expect(await state.lookup("active")).toBeUndefined();
    } finally {
      write.release();
      await active;
      await runtime.stop();
    }
  });

  it("joins an initial pending save during stop and prevents helper dispatch afterward", async () => {
    const state = emptyState();
    const runtime = await createRuntime(state);
    const write = suspendNextWrite(state);
    const dialing = runtime.dial({ handle: "owner@example.com" });
    const rejectedDial = expect(dialing).rejects.toThrow("cancelled before helper dispatch");
    await write.entered;
    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    try {
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(mocks.helper.stop).not.toHaveBeenCalled();
      expect(mocks.helper.startCall).not.toHaveBeenCalled();

      write.release();
      await Promise.all([rejectedDial, stopping]);

      expect(mocks.helper.startCall).not.toHaveBeenCalled();
      expect(mocks.helper.stop).toHaveBeenCalledOnce();
      expect(await state.lookup("active")).toBeUndefined();
    } finally {
      write.release();
      await Promise.all([rejectedDial, stopping]);
    }
  });

  it("closes a promoted call before pending deletion settles and fences delayed readiness", async () => {
    const state = await pendingDialState();
    const runtime = await createRuntime(state);
    const readinessEntered = deferred();
    const releaseReadiness = deferred();
    const talkClosed = deferred();
    const talk = createTalkDriver({
      readyForAudio: async () => {
        readinessEntered.resolve();
        await releaseReadiness.promise;
      },
    });
    talk.close.mockImplementation(async () => {
      talkClosed.resolve();
    });
    mocks.startTalk.mockResolvedValue(talk);
    const deletionEntered = deferred();
    const releaseDeletion = deferred();
    const observe = state.observe.bind(state);
    vi.spyOn(state, "observe").mockImplementationOnce(async (...args) => {
      deletionEntered.resolve();
      await releaseDeletion.promise;
      return await observe(...args);
    });
    const active = mocks.helperParams?.onMessage(outgoingCall("approved-dial", 1));
    let ended: void | Promise<void> = undefined;
    try {
      await readinessEntered.promise;
      ended = mocks.helperParams?.onMessage(outgoingCall("approved-dial", 6));
      await deletionEntered.promise;

      expect((await runtime.status()).calls).toMatchObject([{ phase: "closing" }]);
      expect(await state.lookup("active")).toMatchObject({ dialID: "approved-dial" });
      releaseReadiness.resolve();
      await active;
      await talkClosed.promise;
      expect(talk.close).toHaveBeenCalledWith("native-ended");
      expect(talk.activate).not.toHaveBeenCalled();
      expect(mocks.helper.setMuted).not.toHaveBeenCalled();
      expect(mocks.helper.startTransmission).not.toHaveBeenCalled();

      releaseDeletion.resolve();
      await ended;
      expect((await runtime.status()).calls).toEqual([]);
      expect(await state.lookup("active")).toBeUndefined();
    } finally {
      releaseReadiness.resolve();
      releaseDeletion.resolve();
      await Promise.all([active, ended]);
      await runtime.stop();
    }
  });

  it("publishes cancellation intent before asking the helper to cancel", async () => {
    const state = await pendingDialState();
    const runtime = await createRuntime(state);
    const write = suspendNextWrite(state);
    mocks.helper.cancelOutgoingCall.mockImplementationOnce(async () => {
      expect(await state.lookup("active")).toMatchObject({
        dialID: "approved-dial",
        delivery: "cancelling",
      });
      return pendingDialCancellationResult();
    });
    const hangingUp = runtime.hangup();
    try {
      await write.entered;
      expect(mocks.helper.cancelOutgoingCall).not.toHaveBeenCalled();
      expect(await state.lookup("active")).toMatchObject({ delivery: "accepted" });

      write.release();
      await expect(hangingUp).resolves.toMatchObject({ dialID: "approved-dial" });
      expect(mocks.helper.cancelOutgoingCall).toHaveBeenCalledOnce();
      await mocks.helperParams?.onMessage(outgoingCall("approved-dial", 6));
      expect(await state.lookup("active")).toBeUndefined();
    } finally {
      write.release();
      await hangingUp;
      await runtime.stop();
    }
  });

  it("does not republish a terminal dial when stop overlaps delivery of its deletion result", async () => {
    const state = await pendingDialState();
    const runtime = await createRuntime(state);
    const register = vi.spyOn(state, "register");
    const deleted = deferred();
    const releaseResult = deferred();
    const compareAndApply = state.compareAndApply.bind(state);
    vi.spyOn(state, "compareAndApply").mockImplementationOnce(async (...args) => {
      const result = await compareAndApply(...args);
      deleted.resolve();
      await releaseResult.promise;
      return result;
    });
    const ended = mocks.helperParams?.onMessage(outgoingCall("approved-dial", 6));
    let stopping: Promise<void> | undefined;
    try {
      await deleted.promise;
      expect(await state.lookup("active")).toBeUndefined();
      stopping = runtime.stop();
      await Promise.resolve();

      releaseResult.resolve();
      await Promise.all([ended, stopping]);

      expect(register).not.toHaveBeenCalled();
      expect(mocks.helper.cancelOutgoingCall).not.toHaveBeenCalled();
      expect(await state.lookup("active")).toBeUndefined();
    } finally {
      releaseResult.resolve();
      await ended;
      await (stopping ?? runtime.stop());
    }
  });

  it("joins a late helper reply during stop after a terminal event clears the pending dial", async () => {
    const state = emptyState();
    const runtime = await createRuntime(state);
    const helperEntered = deferred();
    const releaseReply = deferred();
    mocks.helper.startCall.mockImplementationOnce(async (_request: unknown, dialID: string) => {
      helperEntered.resolve();
      await releaseReply.promise;
      return {
        dial_id: dialID,
        call_uuid: "outbound-call",
        muted: true,
        is_uplink_muted: true,
        transport: incomingCall().data.transport,
      };
    });
    const dialing = runtime.dial({ handle: "owner@example.com" });
    let stopping: Promise<void> | undefined;
    try {
      await helperEntered.promise;
      const dialID = (await runtime.status()).outboundCallPending!.dialID;
      await mocks.helperParams?.onMessage(outgoingCall(dialID, 6));
      expect((await runtime.status()).outboundCallPending).toBeUndefined();
      let stopped = false;
      stopping = runtime.stop().then(() => {
        stopped = true;
      });

      expect(await state.lookup("active")).toBeUndefined();
      expect(stopped).toBe(false);
      expect(mocks.helper.stop).not.toHaveBeenCalled();
      releaseReply.resolve();
      await Promise.all([dialing, stopping]);

      expect(mocks.helper.stop).toHaveBeenCalledOnce();
      expect(mocks.helper.cancelOutgoingCall).not.toHaveBeenCalled();
      expect(await state.lookup("active")).toBeUndefined();
    } finally {
      releaseReply.resolve();
      await dialing.catch(() => undefined);
      await (stopping ?? runtime.stop());
    }
  });
});
