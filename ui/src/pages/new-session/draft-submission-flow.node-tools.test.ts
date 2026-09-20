import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAT_ROUTE_READY_EVENT } from "../chat/chat-history-events.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

describe("DraftSubmissionFlow direct node tools", () => {
  it("starts direct node tools atomically without dispatching or transferring a workspace", async () => {
    const { context, flow, gateway, place, request } = createDraftFixture({
      scopes: ["operator.admin"],
    });
    vi.spyOn(place.modelControl, "resolveAgentRuntime").mockReturnValue({
      id: "openclaw",
      source: "model",
      nodeToolsSupported: true,
    });
    vi.spyOn(gateway, "deviceCatalogDisabledReason", "get").mockReturnValue(undefined);
    vi.spyOn(gateway, "environments", "get").mockReturnValue([
      {
        id: "node:desktop",
        type: "node",
        status: "available",
        sessionHost: false,
        invocableCommands: ["system.run"],
      },
    ]);
    const startPlacement = vi.fn();
    context.placementStartup.start = startPlacement;
    vi.mocked(context.sessions.createResult).mockResolvedValue({
      key: "agent:main:node-tools",
      initialRun: { status: "started", runId: "node-tools-turn" },
    });
    vi.mocked(context.navigateAndWait).mockImplementation(async () => {
      queueMicrotask(() => document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT)));
    });
    place.applyFolder("/gateway/previous-workspace");
    place.selectNodeTools("desktop");
    flow.setMessage("Inspect this device");
    expect(flow.submitDisabledReason()).toBeUndefined();
    await flow.submit();

    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    expect(vi.mocked(context.sessions.createResult).mock.calls[0]?.[0]).toMatchObject({
      agentId: "main",
      execNode: "desktop",
      message: "Inspect this device",
    });
    for (const field of [
      "cwd",
      "projectId",
      "projectGitUrl",
      "repository",
      "worktree",
      "worktreeSource",
    ]) {
      expect(vi.mocked(context.sessions.createResult).mock.calls[0]?.[0]).not.toHaveProperty(field);
    }
    expect(startPlacement).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([method]) => method === "sessions.dispatch")).toBe(false);
    flow.disconnect();
  });

  it.each(["stale-inventory", "unsupported-runtime"])(
    "blocks a selected direct-node draft after %s",
    async (reason) => {
      const { context, flow, gateway, place } = createDraftFixture({ scopes: ["operator.admin"] });
      const runtime = vi.spyOn(place.modelControl, "resolveAgentRuntime").mockReturnValue({
        id: "openclaw",
        source: "model",
        nodeToolsSupported: true,
      });
      const readiness = vi
        .spyOn(gateway, "deviceCatalogDisabledReason", "get")
        .mockReturnValue(undefined);
      vi.spyOn(gateway, "environments", "get").mockReturnValue([
        {
          id: "node:desktop",
          type: "node",
          status: "available",
          invocableCommands: ["system.run"],
        },
      ]);
      place.selectNodeTools("desktop");
      flow.setMessage("Inspect this device");
      if (reason === "stale-inventory") {
        readiness.mockReturnValue("Refreshing device inventory");
      } else {
        runtime.mockReturnValue({ id: "other", source: "model", nodeToolsSupported: false });
      }
      expect(flow.submitDisabledReason()).toBe(
        reason === "stale-inventory"
          ? "Refreshing device inventory"
          : "This model runtime cannot use node tools from the Gateway. Choose another model runtime or use the Gateway.",
      );
      await flow.submit();
      expect(context.sessions.createResult).not.toHaveBeenCalled();
      expect(place.execNode).toBe("desktop");
      flow.disconnect();
    },
  );
});
