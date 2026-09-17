import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { projectEmbeddedMessageDeliveryFact } from "../../agents/embedded-agent-message-delivery.js";
import { jsonResult } from "../../agents/tools/common.js";
import { createMessageTool } from "../../agents/tools/message-tool-execution.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { formatMessageCliText } from "../../commands/message-format.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import { resolveMessageActionOutcome } from "./message-action-contracts.js";
import { runMessageAction } from "./message-action-runner.js";

describe("broadcast send outcomes through native actions", () => {
  let tempHome: TempHomeEnv;
  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-broadcast-outcomes-");
  });
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });
  afterAll(async () => {
    await tempHome.restore();
  });

  it.each<{
    name: string;
    payload: Record<string, unknown>;
    ok: boolean;
    sentBeforeError?: true;
  }>([
    {
      name: "native rejection",
      payload: { ok: false, error: "provider rejected message" },
      ok: false,
    },
    {
      name: "native rejection before send",
      payload: { ok: false, error: "rejected before send", sentBeforeError: false },
      ok: false,
    },
    { name: "native suppression", payload: { ok: false, warning: "send suppressed" }, ok: false },
    {
      name: "native partial failure",
      payload: {
        ok: false,
        error: "second part failed",
        sentBeforeError: true,
        messageId: "sent-part",
      },
      ok: false,
      sentBeforeError: true,
    },
    { name: "native success", payload: { ok: true, messageId: "sent-native" }, ok: true },
    { name: "legacy empty success", payload: {}, ok: true },
    {
      name: "nested receipt",
      payload: { ok: true, result: { messageId: "sent-nested" } },
      ok: true,
    },
  ])("preserves $name alongside a successful target", async ({ payload, ok, sentBeforeError }) => {
    const delivered: string[] = [];
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({ id: "broadcast-test" }),
      messaging: { targetResolver: { looksLikeId: () => true } },
      outbound: {
        deliveryMode: "direct",
        sendText: async () => {
          throw new Error("native action bypassed");
        },
      },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        supportsAction: ({ action }) => action === "send",
        handleAction: async ({ params }) => {
          delivered.push(String(params.to));
          return jsonResult(params.to === "first" ? payload : { ok: true, messageId: "sent-2" });
        },
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, plugin, source: "test" }]));

    const result = await runMessageAction({
      cfg: {},
      action: "broadcast",
      params: { channel: plugin.id, targets: ["first", "second"], message: "hello" },
    });

    expect(delivered).toEqual(["first", "second"]);
    expect(result).toMatchObject({
      kind: "broadcast",
      payload: {
        results: [
          { to: "first", ok, payload },
          { to: "second", ok: true },
        ],
      },
    });
    expect(resolveMessageActionOutcome(result).ok).toBe(ok);
    expect(formatMessageCliText(result)[0]).toContain(ok ? "2/2 succeeded" : "1/2 succeeded");
    if (result.kind !== "broadcast") {
      throw new Error("Expected broadcast result");
    }
    expect(result.payload.results[0]?.sentBeforeError).toBe(sentBeforeError);
    expect(result.payload.results[0]?.payload).toBe(payload);
  });

  it.each([
    {
      name: "before the in-flight target dispatches",
      dispatchBeforeWait: false,
      failed: 0,
      notAttempted: 2,
    },
    {
      name: "after the in-flight target starts dispatching",
      dispatchBeforeWait: true,
      failed: 1,
      notAttempted: 1,
    },
  ])("keeps completed results when cancellation arrives $name", async (scenario) => {
    let actionCurrent = true;
    let releaseSecond: () => void = () => undefined;
    const secondStarted = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let enteredSecond: () => void = () => undefined;
    const secondEntered = new Promise<void>((resolve) => {
      enteredSecond = resolve;
    });
    const handled: string[] = [];
    const dispatched: string[] = [];
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({ id: "broadcast-test" }),
      messaging: { targetResolver: { looksLikeId: () => true } },
      outbound: {
        deliveryMode: "direct",
        sendText: async () => {
          throw new Error("native action bypassed");
        },
      },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        supportsAction: ({ action }) => action === "send",
        handleAction: async ({ params, assertDirectAdapterHandoff, onPlatformSendDispatch }) => {
          const target = String(params.to);
          handled.push(target);
          const dispatch = async () => {
            await onPlatformSendDispatch?.();
            dispatched.push(target);
          };
          if (target === "first") {
            await dispatch();
            return jsonResult({ ok: true, messageId: "sent-first" });
          }
          if (scenario.dispatchBeforeWait) {
            await dispatch();
          }
          enteredSecond();
          await secondStarted;
          assertDirectAdapterHandoff?.();
          await dispatch();
          return jsonResult({ ok: true, messageId: `sent-${target}` });
        },
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, plugin, source: "test" }]));

    const pending = runMessageAction({
      cfg: {},
      action: "broadcast",
      params: { channel: plugin.id, targets: ["first", "second", "third"], message: "hello" },
      assertDirectAdapterHandoff: () => {
        if (!actionCurrent) {
          throw Object.assign(new Error("current action canceled"), { name: "AbortError" });
        }
      },
    });
    await secondEntered;
    actionCurrent = false;
    releaseSecond();
    const result = await pending;

    expect(handled).toEqual(["first", "second"]);
    expect(dispatched).toEqual(scenario.dispatchBeforeWait ? ["first", "second"] : ["first"]);
    expect(result).toMatchObject({
      kind: "broadcast",
      payload: {
        results: [
          { to: "first", ok: true, payload: { ok: true, messageId: "sent-first" } },
          { to: "second", ok: false },
          { to: "third", ok: false, attempted: false },
        ],
      },
    });
    if (result.kind !== "broadcast") {
      throw new Error("Expected broadcast result");
    }
    expect(result.payload.results.filter((entry) => entry.attempted === false)).toHaveLength(
      scenario.notAttempted,
    );
    expect(projectEmbeddedMessageDeliveryFact(result)).toMatchObject({
      status: "settled",
      partialDelivery: true,
    });
    const cliOutput = formatMessageCliText(result).join("\n");
    expect(cliOutput).toContain(
      `Broadcast incomplete (1/3 succeeded, ${scenario.failed} failed, ${scenario.notAttempted} not attempted)`,
    );
    expect(cliOutput).toContain("not attempted");
  });

  it.each([undefined, true])(
    "stops core delivery after a rejected handoff (bestEffort: %s)",
    async (bestEffort) => {
      let actionCurrent = true;
      let releaseHandoff: () => void = () => undefined;
      const handoffWait = new Promise<void>((resolve) => {
        releaseHandoff = resolve;
      });
      let enterHandoff: () => void = () => undefined;
      const handoffEntered = new Promise<void>((resolve) => {
        enterHandoff = resolve;
      });
      let insideAdapter = false;
      const transported: string[] = [];
      const plugin: ChannelPlugin = {
        ...createChannelTestPluginBase({ id: "broadcast-test" }),
        messaging: { targetResolver: { looksLikeId: () => true } },
        outbound: {
          deliveryMode: "direct",
          sendText: async (context) => {
            insideAdapter = true;
            try {
              await context.onPlatformSendDispatch?.();
              transported.push(context.to);
              return { messageId: `sent-${context.to}` };
            } finally {
              insideAdapter = false;
            }
          },
        },
      };
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: plugin.id, plugin, source: "test" }]),
      );

      const pending = runMessageAction({
        cfg: {},
        action: "broadcast",
        params: {
          channel: plugin.id,
          targets: ["first", "second", "third"],
          message: "hello",
          ...(bestEffort === undefined ? {} : { bestEffort }),
        },
        onPlatformSendDispatch: async () => {
          if (transported.length > 0 && !insideAdapter) {
            enterHandoff();
            await handoffWait;
          }
        },
        assertDirectAdapterHandoff: () => {
          if (!actionCurrent) {
            throw Object.assign(new Error("current action canceled"), { name: "AbortError" });
          }
        },
      });
      await handoffEntered;
      actionCurrent = false;
      releaseHandoff();
      const result = await pending;

      expect(transported).toEqual(["first"]);
      expect(result).toMatchObject({
        kind: "broadcast",
        payload: {
          results: [
            { to: "first", ok: true },
            { to: "second", ok: false, attempted: false },
            { to: "third", ok: false, attempted: false },
          ],
        },
      });
    },
  );

  it("returns accepted rows through the message tool after turn cancellation", async () => {
    let releaseSecond: () => void = () => undefined;
    const secondWait = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let enterSecond: () => void = () => undefined;
    const secondEntered = new Promise<void>((resolve) => {
      enterSecond = resolve;
    });
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({ id: "broadcast-test" }),
      messaging: { targetResolver: { looksLikeId: () => true } },
      outbound: {
        deliveryMode: "direct",
        sendText: async () => {
          throw new Error("native action bypassed");
        },
      },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        supportsAction: ({ action }) => action === "send",
        handleAction: async ({ params, onPlatformSendDispatch, assertDirectAdapterHandoff }) => {
          const target = String(params.to);
          if (target === "second") {
            enterSecond();
            await secondWait;
            assertDirectAdapterHandoff?.();
          }
          await onPlatformSendDispatch?.();
          return jsonResult({ ok: true, messageId: `sent-${target}` });
        },
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, plugin, source: "test" }]));
    const runId = "broadcast-cancel-tool";
    const sessionKey = "agent:main:broadcast-cancel-tool";
    const sessionId = "broadcast-cancel-tool-session";
    const capability = mintMessageActionTurnCapability({
      agentId: "main",
      runId,
      sessionKey,
      sessionId,
    });
    try {
      const tool = createMessageTool({
        agentId: "main",
        runId,
        agentSessionKey: sessionKey,
        sessionId,
        messageActionTurnCapability: capability,
        config: {},
      });
      const pending = tool.execute("broadcast-cancel-call", {
        action: "broadcast",
        channel: plugin.id,
        targets: ["first", "second", "third"],
        message: "hello",
      });
      await secondEntered;
      revokeMessageActionTurnCapability(capability);
      releaseSecond();
      const result = await pending;

      expect(result.details).toMatchObject({
        results: [
          { to: "first", ok: true },
          { to: "second", ok: false, attempted: false },
          { to: "third", ok: false, attempted: false },
        ],
        messageDelivery: {
          status: "settled",
          partialDelivery: true,
        },
      });
    } finally {
      revokeMessageActionTurnCapability(capability);
    }
  });

  it.each([false, true])(
    "still rejects cancellation when the first destination dispatch started: %s",
    async (dispatchBeforeWait) => {
      let actionCurrent = true;
      let release: () => void = () => undefined;
      const pendingDispatch = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered: () => void = () => undefined;
      const enteredDispatch = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const dispatched: string[] = [];
      const plugin: ChannelPlugin = {
        ...createChannelTestPluginBase({ id: "broadcast-test" }),
        messaging: { targetResolver: { looksLikeId: () => true } },
        outbound: {
          deliveryMode: "direct",
          sendText: async () => {
            throw new Error("native action bypassed");
          },
        },
        actions: {
          describeMessageTool: () => ({ actions: ["send"] }),
          supportsAction: ({ action }) => action === "send",
          handleAction: async ({ assertDirectAdapterHandoff, onPlatformSendDispatch }) => {
            if (dispatchBeforeWait) {
              await onPlatformSendDispatch?.();
              dispatched.push("only");
            }
            entered();
            await pendingDispatch;
            assertDirectAdapterHandoff?.();
            return jsonResult({ ok: true });
          },
        },
      };
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: plugin.id, plugin, source: "test" }]),
      );

      const pending = runMessageAction({
        cfg: {},
        action: "broadcast",
        params: { channel: plugin.id, targets: ["only"], message: "hello" },
        assertDirectAdapterHandoff: () => {
          if (!actionCurrent) {
            throw Object.assign(new Error("current action canceled"), { name: "AbortError" });
          }
        },
      });
      await enteredDispatch;
      actionCurrent = false;
      release();

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(dispatched).toEqual(dispatchBeforeWait ? ["only"] : []);
    },
  );
});
