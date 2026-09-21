import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";

export function registerSideNativeHookRelayPolicyTests(
  support: typeof import("./side-question.test-support.js"),
  mockCall: (mock: ReturnType<typeof vi.fn>, index?: number) => unknown[],
) {
  const {
    readCodexAppServerBindingMock,
    createFakeClient,
    getSharedCodexAppServerClientMock,
    runCodexAppServerSideQuestion,
    sideParams,
    sideLoopRelayParams,
  } = support;
  it("includes permission request native hooks for side threads with yolo approval policy", async () => {
    readCodexAppServerBindingMock.mockReturnValue({
      schemaVersion: 1,
      threadId: "parent-thread",
      sessionFile: "/tmp/session-1.jsonl",
      cwd: "/tmp/workspace",
      authProfileId: "openai:work",
      model: "gpt-5.5",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(
      runCodexAppServerSideQuestion(
        sideParams({
          cfg: { tools: { loopDetection: { enabled: true } } } as never,
          sessionKey: "agent:main:session-1",
        }),
        { nativeHookRelay: { enabled: true } },
      ),
    ).resolves.toEqual({ text: "Side answer." });

    const forkParams = mockCall(client.request)[1] as Record<string, unknown> | undefined;
    const config = forkParams?.config as Record<string, unknown> | undefined;
    expect(forkParams?.approvalPolicy).toBe("never");
    expect(codexHookCommand(config, "hooks.PermissionRequest")?.command).toContain(
      "--event permission_request",
    );
    expect(codexHookCommand(config, "hooks.PreToolUse")?.command).toContain("--event pre_tool_use");
  });

  it("preserves explicitly configured side-thread native hook events", async () => {
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(
      runCodexAppServerSideQuestion(sideParams(), {
        nativeHookRelay: { enabled: true, events: ["permission_request"] },
      }),
    ).resolves.toEqual({ text: "Side answer." });

    const forkParams = mockCall(client.request)[1] as Record<string, unknown> | undefined;
    const config = forkParams?.config as Record<string, unknown> | undefined;
    expect(codexHookCommand(config, "hooks.PermissionRequest")?.command).toContain(
      "--event permission_request",
    );
    expect(config?.["hooks.PreToolUse"]).toBeUndefined();
    expect(config?.["hooks.PostToolUse"]).toBeUndefined();
    expect(config?.["hooks.Stop"]).toBeUndefined();
    const hookState = config?.["hooks.state"] as
      | Record<string, { enabled?: unknown; trusted_hash?: unknown }>
      | undefined;
    expect(codexHookStateForEvent(hookState, "permission_request")?.enabled).toBe(true);
    expect(codexHookStateForEvent(hookState, "pre_tool_use")).toBeUndefined();
    expect(codexHookStateForEvent(hookState, "post_tool_use")).toBeUndefined();
    expect(codexHookStateForEvent(hookState, "stop")).toBeUndefined();
  });

  it("omits native hook overlays when side-thread relay is disabled", async () => {
    // The full kill-switch needs an effective approval policy of "never". The fork
    // policy is resolved from the app-server runtime options, not from the bound
    // thread's recorded policy, so pin it in plugin config.
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(
      runCodexAppServerSideQuestion(sideParams(), {
        pluginConfig: { appServer: { mode: "yolo", approvalPolicy: "never" } },
        nativeHookRelay: { enabled: false },
      }),
    ).resolves.toEqual({ text: "Side answer." });

    const forkParams = mockCall(client.request)[1] as Record<string, unknown> | undefined;
    const config = forkParams?.config as Record<string, unknown> | undefined;
    expect(forkParams?.approvalPolicy).toBe("never");
    expect(config).toMatchObject({
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.shell_tool": true,
      "features.apply_patch_streaming_events": true,
    });
    // Public fork rebuilds native configuration without the parent's per-thread
    // overlay. Leave operator hook arrays and trust state untouched.
    expect(
      Object.keys(config ?? {}).filter(
        (key) => key.startsWith("hooks.") || key === "features.hooks",
      ),
    ).toEqual([]);
  });

  it("retains the before-tool policy relay for a side thread under an explicit never", async () => {
    // Same interlock on the fork path: approvals off, but a live before_tool_call
    // hook still needs the relay that executes it.
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: vi.fn() }]),
    );
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    await expect(
      runCodexAppServerSideQuestion(sideParams(), {
        pluginConfig: { appServer: { mode: "yolo", approvalPolicy: "never" } },
        nativeHookRelay: { enabled: false },
      }),
    ).resolves.toEqual({ text: "Side answer." });

    const forkParams = mockCall(client.request)[1] as Record<string, unknown> | undefined;
    const config = forkParams?.config as Record<string, unknown> | undefined;
    expect(forkParams?.approvalPolicy).toBe("never");
    expect(config?.["features.hooks"]).toBe(true);
    expect(codexHookCommand(config, "hooks.PreToolUse")?.command).toContain("--event pre_tool_use");
  });

  it("narrows a disabled side-thread relay to the before-tool policy relay while approvals prompt", async () => {
    // The side thread runs under a prompting policy, so the opt-out cannot remove
    // the relay the app-server approval bridge and trusted-tool policy run on.
    // Loop detection — not a `before_tool_call` hook — supplies the pre-tool local
    // work, so the prompting policy is the only reason the guard can be narrowing on.
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const client = createFakeClient();
    getSharedCodexAppServerClientMock.mockResolvedValue(client);

    try {
      await expect(
        runCodexAppServerSideQuestion(sideLoopRelayParams(), {
          pluginConfig: { appServer: { mode: "yolo", approvalPolicy: "on-request" } },
          nativeHookRelay: { enabled: false },
        }),
      ).resolves.toEqual({ text: "Side answer." });

      const forkParams = mockCall(client.request)[1] as Record<string, unknown> | undefined;
      const config = forkParams?.config as Record<string, unknown> | undefined;
      expect(forkParams?.approvalPolicy).toBe("on-request");
      expect(config?.["features.hooks"]).toBe(true);
      expect(codexHookCommand(config, "hooks.PreToolUse")?.command).toContain(
        "--event pre_tool_use",
      );
      expect(config?.["hooks.PostToolUse"]).toBeUndefined();
      expect(config?.["hooks.PermissionRequest"]).toBeUndefined();
      expect(config?.["hooks.Stop"]).toBeUndefined();
      const hookState = config?.["hooks.state"] as
        | Record<string, { enabled?: unknown }>
        | undefined;
      expect(codexHookStateForEvent(hookState, "pre_tool_use")?.enabled).toBe(true);
      expect(codexHookStateForEvent(hookState, "post_tool_use")).toBeUndefined();
      expect(codexHookStateForEvent(hookState, "permission_request")).toBeUndefined();
      expect(codexHookStateForEvent(hookState, "stop")).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("narrowed to events [pre_tool_use]"),
        expect.objectContaining({ approvalPolicy: "on-request" }),
      );
    } finally {
      warn.mockRestore();
    }
  });
}

export function codexHookCommand(config: unknown, key: string) {
  const entries = (config as Record<string, unknown> | undefined)?.[key];
  if (!Array.isArray(entries)) {
    return undefined;
  }
  return (
    entries as Array<{ hooks?: Array<{ command?: string; timeout?: number; type?: string }> }>
  )
    .at(0)
    ?.hooks?.at(0);
}

export function codexHookStateForEvent(
  hookState: Record<string, { enabled?: unknown; trusted_hash?: unknown }> | undefined,
  event: string,
) {
  return Object.entries(hookState ?? {}).find(([key]) => key.endsWith(`:${event}:0:0`))?.[1];
}
