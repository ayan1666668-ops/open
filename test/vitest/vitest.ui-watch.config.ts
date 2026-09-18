import type { ViteUserConfig } from "vitest/config";
import { createUiIsolatedVitestConfig } from "./vitest.ui-isolated.config.ts";
import { createUiVitestConfig } from "./vitest.ui.config.ts";

export function createUiWatchVitestConfig(
  env?: Record<string, string | undefined>,
): ViteUserConfig {
  const shared = createUiVitestConfig(env);
  const isolated = createUiIsolatedVitestConfig(env);
  return {
    ...shared,
    test: {
      ...shared.test,
      projects: [
        { ...shared, extends: false },
        { ...isolated, extends: false },
      ],
    },
  };
}

export default createUiWatchVitestConfig();
