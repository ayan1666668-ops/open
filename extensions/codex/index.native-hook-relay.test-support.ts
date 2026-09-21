import { expect, it, vi } from "vitest";
import { createCodexAppServerAgentHarness } from "./harness.js";
import { testCodexAppServerBindingStore } from "./src/app-server/session-binding.test-helpers.js";

export function registerNativeHookRelayForwardingTests(
  runCodexAppServerAttemptMock: ReturnType<typeof vi.fn>,
  runCodexAppServerSideQuestionMock: ReturnType<typeof vi.fn>,
) {
  it("enables the native hook relay for public Codex side questions", async () => {
    const harness = createCodexAppServerAgentHarness({
      pluginConfig: { appServer: {} },
      bindingStore: testCodexAppServerBindingStore,
    });
    const runSideQuestion = harness["runSideQuestion"];
    const result = { text: "ok" };
    runCodexAppServerSideQuestionMock.mockResolvedValueOnce(result);

    if (!runSideQuestion) {
      throw new Error("Expected Codex harness to expose side questions");
    }
    await expect(runSideQuestion({ question: "btw" } as never)).resolves.toBe(result);

    expect(runCodexAppServerSideQuestionMock).toHaveBeenCalledWith(
      { question: "btw" },
      {
        bindingStore: testCodexAppServerBindingStore,
        pluginConfig: { appServer: {} },
        nativeHookRelay: { enabled: true },
      },
    );
  });

  it("disables the native hook relay for attempts when approvals are off and the plugin config opts out", async () => {
    const pluginConfig = {
      appServer: { approvalPolicy: "never", nativeHookRelay: { enabled: false } },
    };
    const harness = createCodexAppServerAgentHarness({
      pluginConfig,
      bindingStore: testCodexAppServerBindingStore,
    });
    const result = { terminal: { kind: "ok" as const } };
    runCodexAppServerAttemptMock.mockResolvedValueOnce(result);

    await expect(harness.runAttempt({ prompt: "hello" } as never)).resolves.toBe(result);

    expect(runCodexAppServerAttemptMock).toHaveBeenCalledWith(
      { prompt: "hello" },
      {
        bindingStore: testCodexAppServerBindingStore,
        pluginConfig,
        nativeHookRelay: { enabled: false },
      },
    );
  });

  it("forwards an attempt opt-out verbatim; the run path guards it", async () => {
    const pluginConfig = { appServer: { nativeHookRelay: { enabled: false } } };
    const harness = createCodexAppServerAgentHarness({
      pluginConfig,
      bindingStore: testCodexAppServerBindingStore,
    });
    const result = { terminal: { kind: "ok" as const } };
    runCodexAppServerAttemptMock.mockResolvedValueOnce(result);

    await expect(harness.runAttempt({ prompt: "hello" } as never)).resolves.toBe(result);

    expect(runCodexAppServerAttemptMock).toHaveBeenCalledWith(
      { prompt: "hello" },
      {
        bindingStore: testCodexAppServerBindingStore,
        pluginConfig,
        nativeHookRelay: { enabled: false },
      },
    );
  });

  it("applies the native hook relay config to public Codex side questions", async () => {
    const pluginConfig = {
      appServer: { approvalPolicy: "never", nativeHookRelay: { enabled: false } },
    };
    const harness = createCodexAppServerAgentHarness({
      pluginConfig,
      bindingStore: testCodexAppServerBindingStore,
    });
    const runSideQuestion = harness["runSideQuestion"];
    const result = { text: "ok" };
    runCodexAppServerSideQuestionMock.mockResolvedValueOnce(result);

    if (!runSideQuestion) {
      throw new Error("Expected Codex harness to expose side questions");
    }
    await expect(runSideQuestion({ question: "btw" } as never)).resolves.toBe(result);

    expect(runCodexAppServerSideQuestionMock).toHaveBeenCalledWith(
      { question: "btw" },
      {
        bindingStore: testCodexAppServerBindingStore,
        pluginConfig,
        nativeHookRelay: { enabled: false },
      },
    );
  });

  it("forwards a side-question opt-out verbatim; the run path guards it", async () => {
    const pluginConfig = { appServer: { nativeHookRelay: { enabled: false } } };
    const harness = createCodexAppServerAgentHarness({
      pluginConfig,
      bindingStore: testCodexAppServerBindingStore,
    });
    const runSideQuestion = harness["runSideQuestion"];
    const result = { text: "ok" };
    runCodexAppServerSideQuestionMock.mockResolvedValueOnce(result);

    if (!runSideQuestion) {
      throw new Error("Expected Codex harness to expose side questions");
    }
    await expect(runSideQuestion({ question: "btw" } as never)).resolves.toBe(result);

    expect(runCodexAppServerSideQuestionMock).toHaveBeenCalledWith(
      { question: "btw" },
      {
        bindingStore: testCodexAppServerBindingStore,
        pluginConfig,
        nativeHookRelay: { enabled: false },
      },
    );
  });
}
