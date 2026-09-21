// Memory Core tests cover REM reflection contamination filtering (#154803).
import { describe, expect, it } from "vitest";
import { isContaminatedDreamingSnippet } from "./short-term-promotion-utils.js";
import {
  rankShortTermPromotionCandidates,
  type ShortTermRecallEntry,
} from "./short-term-promotion.js";
import { createMemoryCoreTestHarness, shortTermTestState } from "./test-helpers.js";

const NOW_ISO = "2026-09-21T10:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

// Shape emitted by buildRemReflections: a "### Reflections" heading plus
// confidence/evidence/note lines, but no `status: staged` and no `recalls: N`.
// The old AND-of-five chain short-circuited on the missing staged fields and
// let these internal self-reflection blocks reach promotion scoring.
const REM_REFLECTION_SNIPPET = [
  "### Reflections",
  "- Theme: `assistant` kept surfacing across 4 memories.",
  "  - confidence: 0.82",
  "  - evidence: memory/.dreams/session-corpus/2026-09-20.md:1-1",
  "  - note: reflection",
].join(" ");

// Alternate serialization with a bare "Reflections:" lead.
const REFLECTIONS_LEAD_SNIPPET =
  "Reflections: operator prefers concise summaries. confidence: 0.82 evidence: memory/2026-09-20.md:1-1 note: reflection";

const DURABLE_NOTE_SNIPPET = "Operator prefers concise summaries and uses vim keybindings.";

function recallEntry(key: string, snippet: string): ShortTermRecallEntry {
  return {
    key,
    path: "memory/2026-09-20.md",
    startLine: 1,
    endLine: 1,
    source: "memory",
    snippet,
    recallCount: 3,
    dailyCount: 0,
    groundedCount: 0,
    totalScore: 1.8,
    maxScore: 0.6,
    firstRecalledAt: "2026-09-18T10:00:00.000Z",
    lastRecalledAt: NOW_ISO,
    queryHashes: ["q-a", "q-b", "q-c"],
    userQueryHashes: ["q-a", "q-b", "q-c"],
    recallDays: ["2026-09-18", "2026-09-19", "2026-09-20"],
    conceptTags: ["summaries", "concise", "operator"],
  };
}

const { createTempWorkspace } = createMemoryCoreTestHarness();

describe("short-term promotion REM reflection filtering (#154803)", () => {
  it("treats REM reflection blocks as contaminated without staged fields", () => {
    expect(isContaminatedDreamingSnippet(REM_REFLECTION_SNIPPET)).toBe(true);
    expect(isContaminatedDreamingSnippet(REFLECTIONS_LEAD_SNIPPET)).toBe(true);
    expect(isContaminatedDreamingSnippet(DURABLE_NOTE_SNIPPET)).toBe(false);
    // Ordinary prose that merely mentions reflection must stay uncontaminated.
    expect(
      isContaminatedDreamingSnippet(
        "My reflections on the release were positive, see memory notes.",
      ),
    ).toBe(false);
  });

  it("keeps REM reflection blocks out of promotion candidates", async () => {
    const workspaceDir = await createTempWorkspace("issue-154803-");
    await shortTermTestState.writeRawRecallStore(workspaceDir, {
      version: 1,
      updatedAt: NOW_ISO,
      entries: {
        reflection: recallEntry("reflection", REM_REFLECTION_SNIPPET),
        durable: recallEntry("durable", DURABLE_NOTE_SNIPPET),
      },
    });

    const candidates = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      nowMs: NOW_MS,
    });
    const candidateKeys = candidates.map((candidate) => candidate.key);
    expect(candidateKeys).toContain("durable");
    expect(candidateKeys).not.toContain("reflection");
  });
});
