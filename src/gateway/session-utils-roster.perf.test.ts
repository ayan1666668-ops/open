import path from "node:path";
import { performance } from "node:perf_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, test, expect, vi } from "vitest";
import { withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { resolveAgentIdentity } from "../agents/identity.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { sessionStoreTargetsFixture } from "./session-list.test-support.js";
import {
  filterAndSortSessionEntries,
  listSessionsFromStoreAsync,
  type SessionListProjectionTiming,
} from "./session-utils-list.js";
import * as rowProjection from "./session-utils-row.js";

describe("session list roster cache lifetime", () => {
  test.each(["entries", "list"] as const)(
    "bounds owner roster traversal for %s and observes the next request's roster",
    (kind) => {
      let rosterReads = 0;
      const agents = Array.from({ length: 30 }, (_, index) => ({
        get id() {
          rosterReads++;
          return `agent-${index}`;
        },
        identity: { name: `Agent ${index}` },
      }));
      const entries = Object.fromEntries(
        agents.map((agent, index) => [`agent-${index}`, { identity: agent.identity }]),
      );
      for (const [id, entry] of Object.entries(entries)) {
        Object.defineProperty(entries, id, {
          configurable: true,
          get: () => {
            rosterReads++;
            return entry;
          },
        });
      }
      const cfg: OpenClawConfig = { agents: kind === "entries" ? { entries } : { list: agents } };
      const store = Object.fromEntries(
        Array.from({ length: 80 }, (_, index) => [
          `agent:agent-29:dashboard:${index}`,
          {
            sessionId: `owned-${index}`,
            updatedAt: index + 1,
            createdActor: { type: "agent" as const, id: "agent-29" },
          },
        ]),
      );
      const select = () =>
        filterAndSortSessionEntries({
          cfg,
          store,
          now: 100,
          opts: { ownerId: "agent-29", limit: 10 },
        });
      rosterReads = 0;
      expect(select().map(([key]) => key)).toEqual(Object.keys(store).toReversed().slice(0, 10));
      expect(rosterReads).toBeLessThanOrEqual(agents.length * 3);
      if (kind === "entries") {
        delete entries["agent-29"];
      } else {
        cfg.agents!.list = agents.slice(0, -1);
      }
      expect(select()).toEqual([]);
    },
  );

  test("reuses roster facts within preparation chunks and refreshes them across a real yield", async () => {
    await withStateDirEnv("openclaw-roster-chunks-", async ({ stateDir }) => {
      resetPluginRuntimeStateForTest();
      setActivePluginRegistry(createEmptyPluginRegistry());
      let rosterReads = 0;
      const agents = Array.from({ length: 30 }, (_, index) => ({
        identity: { name: `Agent ${index}` },
      }));
      const entries = Object.fromEntries(agents.map((entry, index) => [`agent-${index}`, entry]));
      agents.forEach((_, index) => {
        Object.defineProperty(entries, `agent-${index}`, {
          get: () => {
            rosterReads++;
            return agents[index]!;
          },
        });
      });
      const cfg: OpenClawConfig = { agents: { entries } };
      resetConfigRuntimeState();
      setRuntimeConfigSnapshot(cfg);
      let workMs = 0;
      const store = Object.fromEntries(
        Array.from({ length: 80 }, (_, index) => [
          `agent:agent-29:dashboard:${index}`,
          {
            sessionId: `chunk-${index}`,
            updatedAt: index + 1,
            get createdActor() {
              // Charge the real owner projection, after the roster index has been needed.
              workMs++;
              return { type: "agent" as const, id: index < 40 ? "agent-28" : "agent-29" };
            },
          },
        ]),
      );
      const storePath = path.join(stateDir, "sessions.json");
      const targetsBySessionKey = sessionStoreTargetsFixture({ cfg, store, storePath });
      const projectionTiming: SessionListProjectionTiming = {
        prepareSyncMs: 0,
        rowSyncMs: 0,
        yieldWaitMs: 0,
        yieldCount: 0,
      };
      const clock = vi.spyOn(performance, "now").mockImplementation(() => workMs);
      const buildRow = rowProjection.readSessionRowInputs;
      let preparationReads: number | undefined;
      let preparationYields: number | undefined;
      const rows = vi.spyOn(rowProjection, "readSessionRowInputs").mockImplementation((params) => {
        preparationReads ??= rosterReads;
        preparationYields ??= projectionTiming.yieldCount;
        return buildRow(params);
      });
      let identityDuringPause: string | undefined;
      let pauseProbeReads = 0;
      const control = new Promise<void>((resolve) => {
        setImmediate(() => {
          // Replace the whole entry: mutating a shared nested object could hide a leaked cache.
          agents[29] = { identity: { name: "Refreshed owner" } };
          const readsBeforeProbe = rosterReads;
          identityDuringPause = resolveAgentIdentity(cfg, "agent-29")?.name;
          pauseProbeReads = rosterReads - readsBeforeProbe;
          resolve();
        });
      });
      rosterReads = 0;
      try {
        const result = await listSessionsFromStoreAsync({
          cfg,
          store,
          storePath,
          targetsBySessionKey,
          workStartedAt: 0,
          projectionTiming,
          opts: { limit: 1 },
        });
        expect(identityDuringPause).toBe("Refreshed owner");
        expect(result.totalCount).toBe(80);
        expect(result.sessions.map((row) => row.key)).toEqual(["agent:agent-29:dashboard:79"]);
        // This owner is first encountered after the pause, so its facet proves preparation freshness.
        expect(result.owners?.find((owner) => owner.id === "agent-29")?.label).toBe(
          "Refreshed owner",
        );
        const yields = expectDefined(preparationYields, "row projection reached");
        expect(yields).toBeGreaterThan(0);
        const reads = expectDefined(preparationReads, "preparation reads recorded");
        expect(reads - pauseProbeReads).toBeLessThanOrEqual(agents.length * (yields + 4));
      } finally {
        rows.mockRestore();
        clock.mockRestore();
        await control;
      }
    });
  });

  test("bounds row roster lookups and refreshes them across a real row yield", async () => {
    await withStateDirEnv("openclaw-roster-row-chunks-", async ({ stateDir }) => {
      resetPluginRuntimeStateForTest();
      setActivePluginRegistry(createEmptyPluginRegistry());
      const rosterSize = 32;
      const rowCount = 80;
      const ownerId = `agent-${rosterSize - 1}`;
      const entries = Object.fromEntries(
        Array.from({ length: rosterSize }, (_, index) => [
          `agent-${index}`,
          { identity: { name: `Agent ${index}` }, fastModeDefault: false },
        ]),
      );
      let insideRow = false;
      let rowReads = 0;
      const cfg: OpenClawConfig = {
        agents: {
          entries: new Proxy(entries, {
            get(target, key, receiver) {
              if (insideRow && typeof key === "string" && Object.hasOwn(target, key)) {
                rowReads++;
              }
              return Reflect.get(target, key, receiver);
            },
          }),
          defaults: { model: { primary: "example/roster-model" }, thinkingDefault: "off" },
        },
      };
      resetConfigRuntimeState();
      setRuntimeConfigSnapshot(cfg);
      const store = Object.fromEntries(
        Array.from({ length: rowCount }, (_, index) => [
          `agent:${ownerId}:dashboard:${index}`,
          {
            sessionId: `row-chunk-${index}`,
            updatedAt: index + 1,
            createdActor: { type: "agent" as const, id: ownerId },
          },
        ]),
      );
      const storePath = path.join(stateDir, "sessions.json");
      const targetsBySessionKey = sessionStoreTargetsFixture({ cfg, store, storePath });
      const projectionTiming: SessionListProjectionTiming = {
        prepareSyncMs: 0,
        rowSyncMs: 0,
        yieldWaitMs: 0,
        yieldCount: 0,
      };
      let workMs = 0;
      let projectedRows = 0;
      let rowsBeforePause = 0;
      let identityDuringPause: string | undefined;
      let control: Promise<void> | undefined;
      const rowChunks = new Set<number>();
      const clock = vi.spyOn(performance, "now").mockImplementation(() => workMs);
      const buildRow = rowProjection.readSessionRowInputs;
      const rows = vi.spyOn(rowProjection, "readSessionRowInputs").mockImplementation((params) => {
        rowChunks.add(projectionTiming.yieldCount);
        insideRow = true;
        try {
          return buildRow(params);
        } finally {
          insideRow = false;
          projectedRows++;
          workMs++;
          if (projectedRows === 1) {
            control = new Promise<void>((resolve) => {
              setImmediate(() => {
                rowsBeforePause = projectedRows;
                // Whole-entry replacement exposes facts incorrectly retained across await.
                entries[ownerId] = {
                  identity: { name: "Refreshed owner" },
                  fastModeDefault: true,
                };
                identityDuringPause = resolveAgentIdentity(cfg, ownerId)?.name;
                resolve();
              });
            });
          }
        }
      });
      try {
        const result = await listSessionsFromStoreAsync({
          cfg,
          store,
          storePath,
          targetsBySessionKey,
          projectionTiming,
          modelCatalog: [],
          opts: { limit: rowCount },
        });
        expect(result.count).toBe(rowCount);
        expect(result.totalCount).toBe(rowCount);
        expect(result.sessions.map((row) => row.key)).toEqual(Object.keys(store).toReversed());
        expect(rowsBeforePause).toBeGreaterThan(0);
        expect(rowsBeforePause).toBeLessThan(rowCount);
        expect(identityDuringPause).toBe("Refreshed owner");
        expect(result.sessions.map((row) => row.effectiveFastMode)).toEqual(
          Array.from({ length: rowCount }, (_, index) => index >= rowsBeforePause),
        );
        expect(rowChunks.size).toBeGreaterThan(1);
        // Allow an entry index and both legacy-owner facts per real synchronous row chunk.
        // Preparation, target setup, and the outside-batch identity probe are not counted.
        expect(rowReads).toBeLessThanOrEqual(rosterSize * rowChunks.size * 3);
      } finally {
        rows.mockRestore();
        clock.mockRestore();
        await control;
      }
    });
  });

  test("restores an enclosing roster batch after nested selection and failure", () => {
    let ownerEntry = { identity: { name: "Outer owner" } };
    let outerReads = 0;
    const cfg: OpenClawConfig = {
      agents: {
        entries: {
          get owner() {
            outerReads++;
            return ownerEntry;
          },
        },
      },
    };
    const nested: OpenClawConfig = {
      agents: { entries: { owner: { identity: { name: "Nested owner" } } } },
    };
    const store = {
      "agent:owner:dashboard:nested": {
        sessionId: "nested",
        updatedAt: 1,
        createdActor: { type: "agent" as const, id: "owner" },
      },
    };
    withAgentRosterFactsBatch(cfg, () => {
      const identity = resolveAgentIdentity(cfg, "owner");
      for (const selectionConfig of [cfg, nested]) {
        expect(
          filterAndSortSessionEntries({ cfg: selectionConfig, store, now: 2, opts: {} }),
        ).toEqual(Object.entries(store));
        expect(() =>
          filterAndSortSessionEntries({
            cfg: selectionConfig,
            store,
            now: 2,
            opts: {},
            entryFilter: () => {
              expect(resolveAgentIdentity(selectionConfig, "owner")?.name).toBe(
                selectionConfig === cfg ? "Outer owner" : "Nested owner",
              );
              throw new Error("selection stopped");
            },
          }),
        ).toThrow("selection stopped");
        const readsBeforeOuterLookup = outerReads;
        expect(resolveAgentIdentity(cfg, "owner")).toBe(identity);
        expect(outerReads).toBe(readsBeforeOuterLookup);
      }
    });
    ownerEntry = { identity: { name: "Next request" } };
    expect(resolveAgentIdentity(cfg, "owner")?.name).toBe("Next request");
  });
});
