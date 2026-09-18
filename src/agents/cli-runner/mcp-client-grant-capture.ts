// Gateway-owned capture fence for one prepared bundle-MCP client: the bearer the
// child presents, its transfer onto a warm process, capture activation, and
// native tool authority capture. prepare.ts composes it once per prepared run.
import type {
  activateMcpLoopbackClientGrantCapture,
  deactivateMcpLoopbackClientGrantCapture,
  revokeMcpLoopbackClientGrant,
  transferMcpLoopbackClientGrant,
} from "../../gateway/mcp-grant-store.js";
import { assertNativeCronCreatorCapabilities } from "../tools/cron-tool-creator-cap.js";
import type { PreparedCliRunContext } from "./types.js";

export type McpClientGrantCapture = NonNullable<
  PreparedCliRunContext["preparedBackend"]["mcpClientGrantCapture"]
>;

export type McpClientGrantCaptureDeps = {
  activateMcpLoopbackClientGrantCapture: typeof activateMcpLoopbackClientGrantCapture;
  deactivateMcpLoopbackClientGrantCapture: typeof deactivateMcpLoopbackClientGrantCapture;
  revokeMcpLoopbackClientGrant: typeof revokeMcpLoopbackClientGrant;
  transferMcpLoopbackClientGrant: typeof transferMcpLoopbackClientGrant;
};

export function createMcpClientGrantCapture(input: {
  grantToken: string;
  runtimeOwnerToken: string;
  deps: McpClientGrantCaptureDeps;
  assertCurrent?: () => void;
  abortSignal?: AbortSignal;
  /** Present only when this run projects native tool authority through the capture. */
  projectNativeToolAuthority?: (nativeTools: readonly string[]) => readonly string[];
  nativeToolAvailability?: readonly string[];
  webSearchAllowed: boolean;
}): McpClientGrantCapture {
  const { deps, grantToken, runtimeOwnerToken, projectNativeToolAuthority } = input;
  let activeToken = grantToken;
  let activeCapture: ReturnType<typeof deps.activateMcpLoopbackClientGrantCapture> = false;
  return {
    transportToken: grantToken,
    adoptProcessToken: (processToken) => {
      if (activeToken === processToken) {
        return;
      }
      if (
        !deps.transferMcpLoopbackClientGrant({
          sourceToken: grantToken,
          targetToken: processToken,
          runtimeOwnerToken,
        })
      ) {
        throw new Error("CLI MCP client grant could not transfer onto the live process bearer");
      }
      activeToken = processToken;
    },
    revokeProcessToken: (closeReason) => {
      deps.revokeMcpLoopbackClientGrant(activeToken, closeReason);
    },
    activate: (captureKey, assertCurrent) => {
      const activated = deps.activateMcpLoopbackClientGrantCapture({
        token: activeToken,
        runtimeOwnerToken,
        captureKey,
        assertCurrent,
      });
      if (!activated) {
        throw new Error("CLI MCP client grant is no longer valid for this Gateway runtime");
      }
      activeCapture = activated;
    },
    deactivate: (captureKey) => {
      deps.deactivateMcpLoopbackClientGrantCapture({
        token: activeToken,
        runtimeOwnerToken,
        captureKey,
      });
    },
    ...(projectNativeToolAuthority
      ? {
          captureNativeTools: (tools: unknown) => {
            input.assertCurrent?.();
            input.abortSignal?.throwIfAborted();
            if (!activeCapture || !activeCapture.captureNativeToolAuthority(null)) {
              throw new Error("Native tool authority capture is no longer active.");
            }
            if (
              !Array.isArray(tools) ||
              !tools.every((name): name is string => typeof name === "string")
            ) {
              throw new Error(
                "Native runtime reported an invalid tool list; start a fresh session.",
              );
            }
            const selected = input.nativeToolAvailability;
            const capabilities = projectNativeToolAuthority(
              selected ? tools.filter((name) => selected.includes(name)) : tools,
            );
            assertNativeCronCreatorCapabilities(capabilities);
            const allowed = capabilities.filter(
              (name) => name !== "web_search" || input.webSearchAllowed,
            );
            if (!activeCapture.captureNativeToolAuthority(allowed)) {
              throw new Error("Native tool authority capture is no longer active.");
            }
          },
        }
      : {}),
  };
}
