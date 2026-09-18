import { onTestFinished } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
function registerCliBackendsForTest(): void {
  const backends = [
    {
      id: "claude-cli",
      modelProvider: "anthropic",
      pluginId: "anthropic",
      config: { command: "claude" },
      bundleMcp: false,
    },
    {
      id: "google-gemini-cli",
      modelProvider: "google",
      pluginId: "google",
      config: { command: "gemini" },
      bundleMcp: false,
    },
  ] as const;
  const previous = captureActivePluginRegistrySnapshot();
  setActivePluginRegistry({
    ...createEmptyPluginRegistry(),
    cliBackends: backends.map((backend) => ({
      pluginId: backend.pluginId,
      source: "test",
      backend,
    })),
  });
  onTestFinished(() => restoreActivePluginRegistrySnapshot(previous));
}

export { registerCliBackendsForTest };
