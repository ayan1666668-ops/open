// Recall rehydration must keep a stored range anchored to its own lines, and it
// must orphan a candidate rather than substitute a fragment or an ambiguous
// match for the recalled text (#151173).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rehydratePromotionCandidate } from "./short-term-promotion-rehydrate.js";
import type { PromotionCandidate } from "./short-term-promotion-types.js";

const NOTE_RELATIVE_PATH = "memory/2026-09-18.md";

function makeCandidate(params: {
  snippet: string;
  startLine: number;
  endLine: number;
}): PromotionCandidate {
  return {
    key: "rehydrate-candidate",
    path: NOTE_RELATIVE_PATH,
    startLine: params.startLine,
    endLine: params.endLine,
    source: "memory",
    snippet: params.snippet,
    recallCount: 3,
    signalCount: 3,
    avgScore: 1,
    maxScore: 1,
    uniqueQueries: 2,
    firstRecalledAt: "2026-09-17T00:00:00.000Z",
    lastRecalledAt: "2026-09-17T12:00:00.000Z",
    ageDays: 1,
    score: 1,
    recallDays: ["2026-09-17"],
    conceptTags: [],
    components: {
      frequency: 1,
      relevance: 1,
      diversity: 1,
      recency: 1,
      consolidation: 1,
      conceptual: 1,
    },
  };
}

let workspaceDir: string;

async function writeNote(lines: string[]): Promise<void> {
  const notePath = path.join(workspaceDir, NOTE_RELATIVE_PATH);
  await fs.mkdir(path.dirname(notePath), { recursive: true });
  await fs.writeFile(notePath, `${lines.join("\n")}\n`, "utf-8");
}

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "recall-rehydrate-"));
});

afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe("rehydratePromotionCandidate", () => {
  it("keeps the stored range when the note only gained an HTML comment", async () => {
    const snippet = "Alpha sentence one. Beta sentence two.";
    await writeNote([
      "# Daily",
      "",
      "Alpha sentence one.",
      "<!-- scratch note -->",
      "Beta sentence two.",
      "",
      "Tail line.",
    ]);

    const rehydrated = await rehydratePromotionCandidate(
      workspaceDir,
      makeCandidate({ snippet, startLine: 3, endLine: 5 }),
    );

    expect(rehydrated?.startLine).toBe(3);
    expect(rehydrated?.endLine).toBe(5);
    expect(rehydrated?.snippet).toContain("Alpha sentence one.");
    expect(rehydrated?.snippet).toContain("Beta sentence two.");
  });

  it("orphans the candidate when only a fragment of the recorded text survives", async () => {
    const snippet = "Alpha sentence one. Beta sentence two. Gamma sentence three.";
    await writeNote([
      "# Daily",
      "Beta sentence two.",
      "Unrelated line.",
      "Beta sentence two.",
      "Another line.",
      "Beta sentence two.",
    ]);

    const rehydrated = await rehydratePromotionCandidate(
      workspaceDir,
      makeCandidate({ snippet, startLine: 2, endLine: 4 }),
    );

    expect(rehydrated).toBeNull();
  });

  it("still relocates a candidate whose recorded text survives in one place", async () => {
    const snippet = "Delta fact about the release.";
    await writeNote([
      "# Daily",
      "",
      "Opening line.",
      "",
      "",
      "",
      "",
      "",
      "Delta fact about the release.",
      "",
      "Closing line.",
    ]);

    const rehydrated = await rehydratePromotionCandidate(
      workspaceDir,
      makeCandidate({ snippet, startLine: 3, endLine: 3 }),
    );

    expect(rehydrated).not.toBeNull();
    expect(rehydrated?.snippet).toContain("Delta fact about the release.");
  });

  it("orphans the candidate when equally close copies of the recorded text are disjoint", async () => {
    const snippet = "Epsilon fact about the recall store.";
    await writeNote([
      "# Daily",
      "Alpha line.",
      "Epsilon fact about the recall store.",
      "Beta line.",
      "Gamma line.",
      "Line that moved away.",
      "Delta line.",
      "Theta line.",
      "Epsilon fact about the recall store.",
      "Closing line.",
    ]);

    const rehydrated = await rehydratePromotionCandidate(
      workspaceDir,
      makeCandidate({ snippet, startLine: 6, endLine: 6 }),
    );

    expect(rehydrated).toBeNull();
  });
});
