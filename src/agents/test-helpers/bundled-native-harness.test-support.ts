import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import type {
  AgentHarnessAttemptParamsV2,
  AgentHarnessSupportContext,
  AgentHarnessV2,
} from "../harness/types.js";

type NativeHarnessFixture = {
  harness: AgentHarnessV2;
  bindNativeSession: (
    params: Pick<
      AgentHarnessAttemptParamsV2,
      "agentId" | "sessionId" | "sessionKey" | "workspaceDir"
    > &
      Required<Pick<AgentHarnessSupportContext, "provider" | "modelId">> & { threadId: string },
  ) => Promise<boolean>;
};

export async function loadNativeHarnessFixture(
  options: { label?: string } = {},
): Promise<NativeHarnessFixture> {
  const { createCodexHarnessFixtureForTest } = await loadBundledPluginFacade<{
    createCodexHarnessFixtureForTest: (options: {
      label?: string;
    }) => Promise<NativeHarnessFixture>;
  }>({ pluginId: "codex", artifactBasename: "test-api.js" });
  return createCodexHarnessFixtureForTest(options);
}
