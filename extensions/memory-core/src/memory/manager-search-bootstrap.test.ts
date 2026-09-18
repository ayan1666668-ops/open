import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory search bootstrap", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { provider: providerFixture } = fixture;
  const {
    createConfig: createCfg,
    getFreshManager,
    getFtsSessionManager,
    getPersistentManager,
    seedSessionTranscript: seedMemoryIndexSessionTranscript,
  } = fixture;

  it("bootstraps an empty index on first search so session transcript hits are available", async () => {
    const manager = await getFtsSessionManager();
    if (!manager) {
      return;
    }

    await seedMemoryIndexSessionTranscript({
      sessionId: "session-bootstrap",
      messages: [
        {
          role: "assistant",
          timestamp: "2026-04-07T15:25:04.113Z",
          content: "The current Project Nebula codename is ORBIT-10.",
        },
      ],
    });

    const results = await manager.search("current Project Nebula codename ORBIT-10", {
      minScore: 0,
      maxResults: 3,
    });

    expect(results[0]?.source).toBe("sessions");
    expect(results[0]?.snippet).toContain("ORBIT-10");
  });

  it.each(["memory", "sessions"] as const)(
    "discovers new %s content after empty CLI searches without repeatedly repairing the index",
    async (source) => {
      await fs.unlink(path.join(fixture.paths.memory, "2026-01-12.md"));
      providerFixture.forceNoProvider = true;
      const cfg = createCfg({
        provider: "none",
        sources: ["memory", "sessions"],
        rememberAcrossConversations: true,
        minScore: 0,
      });
      cfg.agents = { defaults: cfg.agents?.defaults, entries: { main: {} } };
      const manager = await getFreshManager(cfg, "cli");
      expect(manager.status().fts?.available).toBe(true);
      expect(manager.status().sources).toEqual(["memory", "sessions"]);

      await expect(manager.search("Heliotrope", { minScore: 0 })).resolves.toEqual([]);
      const initialRepairSequence = asOptionalRecord(
        manager.status().custom?.automaticRebuildNotice,
      )?.sequence;
      expect(initialRepairSequence).toEqual(expect.any(Number));
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(manager.search("Heliotrope", { minScore: 0 })).resolves.toEqual([]);
        expect(manager.status().custom?.automaticRebuildNotice).toMatchObject({
          sequence: initialRepairSequence,
        });
      }

      if (source === "memory") {
        await fs.writeFile(
          path.join(fixture.paths.workspace, "MEMORY.md"),
          "Heliotrope sentinel is now searchable.",
        );
      } else {
        await seedMemoryIndexSessionTranscript({
          sessionId: "after-empty-search",
          messages: [
            {
              role: "assistant",
              timestamp: "2026-04-07T15:25:04.113Z",
              content: "Heliotrope sentinel is now searchable.",
            },
          ],
        });
      }

      const results = await manager.search("Heliotrope", { minScore: 0 });
      expect(results[0]?.source).toBe(source);
      expect(results[0]?.snippet).toContain("Heliotrope sentinel");
      expect(manager.status().custom?.automaticRebuildNotice).toMatchObject({
        sequence: initialRepairSequence,
      });
    },
  );

  it("returns before provider or index bootstrap for a blank query", async () => {
    const manager = await getPersistentManager(createCfg({ provider: "required-provider" }));
    providerFixture.providerCalls = [];

    await expect(manager.search(" \n\t ")).resolves.toStrictEqual([]);

    expect(providerFixture.providerCalls).toHaveLength(0);
  });
});
