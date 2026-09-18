import { vi } from "vitest";

vi.mock("./subagent-spawn-deps.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-spawn-deps.js")>();
  const { supportedSpawnExecutionSelection } = await import("./subagent-spawn.test-helpers.js");
  return {
    ...actual,
    getSubagentSpawnDeps: () => ({
      ...actual.getSubagentSpawnDeps(),
      prepareSessionExecutionSelection: supportedSpawnExecutionSelection,
    }),
  };
});
