import { describe, expect, it } from "vitest";
import { getSessionExecutionSelection } from "../../model-picker/execution-selection-state.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createRuntimeAgent } from "./runtime-agent.js";

describe("plugin runtime session creation colors", () => {
  it.each([
    { color: " Blue ", expectedColor: "blue" },
    { color: "invalid", expectedColor: undefined },
    { color: undefined, expectedColor: undefined },
  ])(
    "creates a plugin-owned CLI fork with canonical color $color",
    async ({ color, expectedColor }) => {
      await withOpenClawTestState({ label: "plugin-runtime-cli-session-create" }, async () => {
        const runtime = createRuntimeAgent();
        const key = "agent:main:catalog-adopt:claude:source";
        const created = await runtime.session.createSessionEntry({
          cfg: {},
          key,
          label: "Renamed CLI session",
          execNode: "node-a",
          execCwd: "/work/on-node",
          initialEntry: {
            cliBackendId: "claude-cli",
            color,
            model: "qa-native-model",
            modelSelectionLocked: true,
            pluginOwnerId: "anthropic",
            cliSessionBinding: {
              sessionId: "claude-source",
              forceReuse: true,
              forkNextResume: true,
            },
          },
          afterCreate: async ({ entry }) => {
            expect(entry.initializationPending).toBe(true);
            expect(entry.color).toBe(expectedColor);
          },
        });
        expect(created.entry.color).toBe(expectedColor);
        expect(getSessionExecutionSelection(created.entry, {})).toEqual({
          executor: { kind: "cli", id: "claude-cli" },
          model: { provider: "claude-cli", id: "qa-native-model" },
        });
        expect(
          runtime.session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
        ).toEqual(created.entry);
        expect(created.entry).toMatchObject({
          label: "Renamed CLI session",
          createdVia: "plugin",
          createdActor: { type: "system", id: "anthropic" },
          createdAt: expect.any(Number),
          pluginOwnerId: "anthropic",
          modelSelectionLocked: true,
          execHost: "node",
          execNode: "node-a",
          execCwd: "/work/on-node",
          cliSessionBindings: {
            "claude-cli": {
              sessionId: "claude-source",
              forceReuse: true,
              forkNextResume: true,
            },
          },
        });
      });
    },
  );
});
