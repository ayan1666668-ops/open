import { afterEach, expect, it, vi } from "vitest";
import { identityPreferences } from "./draft-worktree-preferences.test-support.ts";
import { loadNewSessionPreference } from "./preferences.ts";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

function connectCommandComputer(
  fixture: ReturnType<ReturnType<typeof identityPreferences>["make"]>,
) {
  vi.spyOn(fixture.place.modelControl, "resolveAgentRuntime").mockReturnValue({
    id: "openclaw",
    source: "model",
    nodeToolsSupported: true,
  });
  vi.spyOn(fixture.gateway, "cloudProfilesReady", "get").mockReturnValue(true);
  vi.spyOn(fixture.gateway, "deviceCatalogDisabledReason", "get").mockReturnValue(undefined);
  vi.spyOn(fixture.gateway, "environments", "get").mockReturnValue([
    {
      id: "node:desktop",
      type: "node",
      status: "available",
      sessionHost: false,
      invocableCommands: ["system.run"],
    },
  ]);
}

it("keeps a fresh install local until an explicit command destination is saved and restored", async () => {
  const prefs = identityPreferences(true, undefined, {});
  const first = prefs.make();
  connectCommandComputer(first);
  try {
    await prefs.ready(first);
    expect(first.gateway.readPreference("main")).toBeNull();
    expect(first.place.preferenceSelection().where).toEqual({ kind: "local" });
    expect(prefs.stored()).toBeUndefined();

    first.place.selectNodeTools("desktop");
    await vi.waitFor(() =>
      expect(prefs.stored()).toMatchObject({ where: { kind: "node-tools", id: "desktop" } }),
    );
    first.flow.disconnect();

    const restored = prefs.make();
    connectCommandComputer(restored);
    try {
      await vi.waitFor(() => expect(restored.gateway.preferenceLoading).toBe(false));
      restored.place.restorePreferenceSelections();
      expect(restored.place.execNode).toBe("desktop");
      expect(restored.place.deviceId).toBe("");
      expect(restored.place.remotePlacement).toBe(false);
      expect(restored.place.devicePlacementReady()).toBe(true);
      expect(restored.context.sessions.createResult).not.toHaveBeenCalled();
    } finally {
      restored.flow.disconnect();
    }
  } finally {
    first.flow.disconnect();
  }
});

it.each(["browser", "identity"] as const)(
  "preserves v2026.9.5 %s preferences before explicitly choosing command-only execution",
  async (source) => {
    // Published v2026.9.5 uses these v1 keys and this device discriminator.
    const legacy = {
      workspace: "/repo",
      folder: "/repo",
      where: { kind: "device", id: "desktop" },
      worktree: true,
      freshWorkspace: false,
      baseRef: "main",
      worktreeName: "existing-task",
      model: "example/existing-model",
      thinkingLevel: "high",
    };
    const other = { folder: "/other", where: { kind: "local" } };
    if (source === "browser") {
      localStorage.setItem(
        "openclaw.new-session.preferences.v1:ws://gateway.example",
        JSON.stringify({ agents: { main: legacy, work: other } }),
      );
    }
    const prefs = identityPreferences(
      true,
      async () => ({
        models: [
          { id: "gpt-5.6-luna", name: "Default model", provider: "openai" },
          {
            id: "existing-model",
            name: "Existing model",
            provider: "example",
            reasoning: true,
            thinkingLevels: [{ id: "high", label: "High" }],
          },
        ],
      }),
      source === "identity"
        ? {
            "new-session.migration.v1": true,
            "new-session.v1:main": legacy,
            "new-session.v1:work": other,
          }
        : {},
    );
    const first = prefs.make();
    connectCommandComputer(first);
    try {
      await vi.waitFor(() => expect(first.gateway.preferenceLoading).toBe(false));
      first.place.restorePreferenceSelections();
      expect(first.gateway.readPreference("main")).toEqual(legacy);
      expect(first.place.deviceId).toBe("desktop");
      expect(first.place.execNode).toBe("");
      expect(prefs.stored("work")).toEqual(other);

      first.place.selectNodeTools("desktop");
      await vi.waitFor(() =>
        expect(prefs.stored()).toMatchObject({
          where: { kind: "node-tools", id: "desktop" },
          model: legacy.model,
          thinkingLevel: legacy.thinkingLevel,
        }),
      );
      expect(loadNewSessionPreference("ws://gateway.example", "main")?.where).toEqual({
        kind: "node-tools",
        id: "desktop",
      });
      expect(first.place.deviceId).toBe("");
      expect(first.place.remotePlacement).toBe(false);
      expect(prefs.stored("work")).toEqual(other);
    } finally {
      first.flow.disconnect();
    }
  },
);
