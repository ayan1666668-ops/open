import { expect } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { PreparedAgentCredentialModes } from "../agents/agent-auth-credential-modes.js";
import { createSessionModelCatalogFixture } from "../agents/test-helpers/session-model-catalog.test-support.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { embeddedRunMock } from "./test-helpers.js";
import { getTestPluginRegistry } from "./test-helpers.plugin-registry.js";
import {
  getGatewayConfigModule,
  type setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

export function createCompactionClientOpener(
  openGatewayClient: ReturnType<typeof setupGatewaySessionsTestHarness>["openClient"],
) {
  return async function openClient(
    options?: Parameters<typeof openGatewayClient>[0],
    runtimeAuthModes: PreparedAgentCredentialModes = {},
  ) {
    const client = await openGatewayClient(options);
    // Opening the client publishes the final config. Catalog/auth must share that identity.
    const cfg = (await getGatewayConfigModule()).getRuntimeConfig();
    const entry = {
      provider: "anthropic",
      id: "claude-opus-4-6",
      name: "Compaction model",
      api: "anthropic-messages" as const,
    };
    const cliBackend = getTestPluginRegistry().cliBackends.find(
      ({ backend }) => backend.id === "claude-cli",
    );
    const plugins = cliBackend
      ? createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: cliBackend.pluginId,
              cliBackends: ["claude-cli"],
              syntheticAuthRefs: ["claude-cli"],
            },
          ],
        }).plugins
      : [];
    createSessionModelCatalogFixture().publish({
      config: cfg,
      agentId: "main",
      catalog: { entries: [entry], routeVariants: [entry] },
      profiles: {
        "anthropic:compaction": {
          type: "api_key",
          provider: "anthropic",
          key: "synthetic-compaction-credential",
        },
      },
      plugins,
      runtimeAuthModes,
    });
    return client;
  };
}

type HeldCompactionResult = {
  ok: true;
  compacted: true;
  result: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    tokensAfter: number;
    sessionId?: string;
  };
};

export function holdCompaction(result: HeldCompactionResult) {
  const entered = createDeferred();
  const terminal = createDeferred<HeldCompactionResult>();
  embeddedRunMock.compactEmbeddedAgentSession.mockImplementationOnce(() => {
    entered.resolve();
    return terminal.promise;
  });
  return {
    release: () => terminal.resolve(result),
    waitForEntry: async (compactResult: Promise<unknown>) => {
      // Admission can outlast waitFor's default; only backend entry makes the held result ready.
      await Promise.race([
        entered.promise,
        compactResult.then((response) => {
          throw new Error(
            `Compaction RPC completed before backend entry: ${JSON.stringify(response)}`,
          );
        }),
      ]);
      expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledTimes(1);
    },
  };
}

export function isCompactOperationEvent(message: unknown, phase: "start" | "end") {
  const candidate = message as {
    event?: unknown;
    payload?: { operation?: unknown; phase?: unknown };
    type?: unknown;
  };
  return (
    candidate.type === "event" &&
    candidate.event === "session.operation" &&
    candidate.payload?.operation === "compact" &&
    candidate.payload?.phase === phase
  );
}

export function expectMainCompactionResult(
  compacted: { ok?: boolean; payload?: { compacted?: boolean; key?: string } | null },
  expectedCompacted: boolean,
) {
  expect(compacted.ok, JSON.stringify(compacted)).toBe(true);
  expect(compacted.payload?.key).toBe("agent:main:main");
  expect(compacted.payload?.compacted, JSON.stringify(compacted)).toBe(expectedCompacted);
}
