import type { SessionAcpMeta } from "@openclaw/acp-core/types";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, test, vi } from "vitest";
import { AcpSessionManager } from "../acp/control-plane/manager.core.js";
import { disposeAcpSessionManagerInstance } from "../acp/control-plane/manager.lifecycle.js";
import * as acpStore from "../acp/runtime/session-meta.js";
import type { AcpSessionStoreEntry as InternalStoreEntry } from "../acp/runtime/session-meta.js";
import { getAcpSessionManager, readAcpSessionEntry, testing } from "./acp-runtime.js";

const cfg = { acp: { enabled: true, backend: "qa-backend", dispatch: { enabled: true } } };
const sessionKey = "agent:main:acp:public-selection";
const stored: InternalStoreEntry = {
  cfg,
  agentId: "main",
  storePath: "/synthetic/session-store",
  sessionKey,
  storeSessionKey: sessionKey,
  entry: {
    sessionId: "public-session",
    lifecycleRevision: "public-generation",
    updatedAt: 1,
    executionSelection: {
      state: "accepted",
      fallbackPermission: "explicit",
      selection: {
        executor: { kind: "acp", backend: "qa-backend", agent: "qa-agent" },
        model: { id: "qa-model" },
      },
    },
  },
  acp: {
    runtimeSessionName: "qa-native-session",
    mode: "persistent",
    state: "idle",
    lastActivityAt: 1,
    runtimeOptions: { thinking: "high" },
  },
};
const managers: AcpSessionManager[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    await disposeAcpSessionManagerInstance(manager, "test-complete");
  }
  testing.resetAcpSessionManagerForTests();
  vi.restoreAllMocks();
});

function expectPublicMeta(meta: SessionAcpMeta) {
  expect(meta).toMatchObject({
    backend: "qa-backend",
    agent: "qa-agent",
    runtimeOptions: { model: "qa-model", thinking: "high" },
  });
}

test("the public ACP store read projects the committed pair without adding selectors to lifecycle storage", () => {
  vi.spyOn(acpStore, "readAcpSessionEntryCore").mockImplementation(() => structuredClone(stored));
  const projected = expectDefined(
    readAcpSessionEntry({ cfg, agentId: "main", sessionKey }),
    "projected ACP session",
  );
  expectPublicMeta(expectDefined(projected.acp, "projected ACP metadata"));
  expect(stored.acp).not.toHaveProperty("backend");
  expect(stored.acp?.runtimeOptions).not.toHaveProperty("model");
  expect(projected.entry?.sessionId).toBe("public-session");
});

test("the public manager keeps one actor and projects its released resolution shape", () => {
  const manager = new AcpSessionManager({
    loadSessionEntry: () => structuredClone(stored),
    listAcpSessions: async () => [structuredClone(stored)],
    upsertSessionMeta: async () => {
      throw new Error("read-only test");
    },
    getRuntimeBackend: () => null,
    requireRuntimeBackend: () => {
      throw new Error("read-only test");
    },
  });
  managers.push(manager);
  testing.setAcpSessionManagerForTests(manager);
  const facade = getAcpSessionManager();
  expect(getAcpSessionManager()).toBe(facade);
  const result = facade.resolveSession({ cfg, agentId: "main", sessionKey });
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") {
    throw new Error("expected ready session");
  }
  expectPublicMeta(result.meta);
  expect(facade.getObservabilitySnapshot()).toEqual(manager.getObservabilitySnapshot());
  const internal = manager.resolveSession({ cfg, agentId: "main", sessionKey });
  if (internal.kind !== "ready") {
    throw new Error("expected ready session");
  }
  expect(internal.meta).not.toHaveProperty("backend");
  expect(internal.selection.model).toEqual({ id: "qa-model" });
});
