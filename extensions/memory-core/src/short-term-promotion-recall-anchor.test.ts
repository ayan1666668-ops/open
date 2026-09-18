// Memory Core tests cover recall anchor normalization on short term promotion rehydration.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it as baseIt, vi } from "vitest";
import {
  applyShortTermPromotions,
  rankShortTermPromotionCandidates,
  recordShortTermRecalls,
} from "./short-term-promotion.js";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "./test-helpers.js";

vi.mock("openclaw/plugin-sdk/memory-host-events", () => ({
  appendMemoryHostEvent: vi.fn(async () => {}),
}));

type RecordRecallParams = Parameters<typeof recordShortTermRecalls>[0];
type RecallResult = RecordRecallParams["results"][number];
type RecallResultExtras = Partial<
  Omit<RecallResult, "path" | "startLine" | "endLine" | "score" | "snippet" | "source">
>;
type RankAllOptions = Omit<
  Parameters<typeof rankShortTermPromotionCandidates>[0],
  "workspaceDir" | "minScore" | "minRecallCount" | "minUniqueQueries"
>;
type ApplyAllOptions = Omit<
  Parameters<typeof applyShortTermPromotions>[0],
  "workspaceDir" | "candidates" | "minScore" | "minRecallCount" | "minUniqueQueries"
>;

const allPromotionThresholds = {
  minScore: 0,
  minRecallCount: 0,
  minUniqueQueries: 0,
} as const;

function memoryRecallResult(
  memoryPath: string,
  startLine: number,
  endLine: number,
  score: number,
  snippet: string,
  extras: RecallResultExtras = {},
): RecallResult {
  return { ...extras, path: memoryPath, startLine, endLine, score, snippet, source: "memory" };
}

function recordMemoryRecalls(
  workspaceDir: string,
  query: string,
  results: RecallResult[],
  options: Omit<RecordRecallParams, "workspaceDir" | "query" | "results"> = {},
): Promise<void> {
  return recordShortTermRecalls({ ...options, workspaceDir, query, results });
}

function rankAllCandidates(workspaceDir: string, options: RankAllOptions = {}) {
  return rankShortTermPromotionCandidates({ ...options, workspaceDir, ...allPromotionThresholds });
}

function applyAllCandidates(
  workspaceDir: string,
  candidates: Parameters<typeof applyShortTermPromotions>[0]["candidates"],
  options: ApplyAllOptions = {},
) {
  return applyShortTermPromotions({
    ...options,
    workspaceDir,
    candidates,
    ...allPromotionThresholds,
  });
}

describe("short-term promotion recall anchors", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    await configureMemoryCoreDreamingStateForTests();
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-promote-anchor-"));
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    resetMemoryCoreDreamingStateForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function withTempWorkspace(run: (workspaceDir: string) => Promise<void>) {
    const workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
    await run(workspaceDir);
  }

  type WorkspaceTest = (title: string, run: (workspaceDir: string) => Promise<void>) => void;
  const it: WorkspaceTest = (title, run) =>
    baseIt(title, async () => {
      await withTempWorkspace(run);
    });

  async function writeDailyMemoryNote(
    workspaceDir: string,
    date: string,
    lines: string[],
  ): Promise<string> {
    const notePath = path.join(workspaceDir, "memory", `${date}.md`);
    await fs.writeFile(notePath, `${lines.join("\n")}\n`, "utf-8");
    return notePath;
  }

  it("rehydrates snippets whose live range gained an HTML comment", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
      "intro",
      "summary",
      "Moved backups to S3 Glacier.",
      "Keep cold storage retention at 365 days.",
    ]);
    await recordMemoryRecalls(workspaceDir, "glacier", [
      memoryRecallResult(
        "memory/2026-04-01.md",
        3,
        4,
        0.94,
        "Moved backups to S3 Glacier. Keep cold storage retention at 365 days.",
      ),
    ]);
    // A later tool adds an HTML comment inside the recorded range; the snippet
    // text itself is unchanged, so the same normalization must apply on both
    // sides of the comparison.
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
      "intro",
      "summary",
      "Moved backups to S3 Glacier.",
      "<!-- updated during review -->",
      "Keep cold storage retention at 365 days.",
    ]);

    const ranked = await rankAllCandidates(workspaceDir);
    const applied = await applyAllCandidates(workspaceDir, ranked);

    expect(applied.applied).toBe(1);
    expect(applied.appliedCandidates[0]?.startLine).toBe(3);
    expect(applied.appliedCandidates[0]?.endLine).toBe(5);
    expect(applied.appliedCandidates[0]?.snippet).toBe(
      "Moved backups to S3 Glacier. Keep cold storage retention at 365 days.",
    );
  });

  it("does not anchor promotion on a fragment when the live range lost content", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
      "intro",
      "summary",
      "Moved backups to S3 Glacier.",
      "",
    ]);
    await recordMemoryRecalls(workspaceDir, "glacier", [
      memoryRecallResult(
        "memory/2026-04-01.md",
        3,
        4,
        0.94,
        "Moved backups to S3 Glacier. Keep cold storage retention at 365 days.",
      ),
    ]);

    const ranked = await rankAllCandidates(workspaceDir);
    const applied = await applyAllCandidates(workspaceDir, ranked);

    // The stored two-line snippet only survives as its first line, so the
    // scan can only offer a fragment of the recorded content. Promoting that
    // fragment would silently carry the wrong lines into MEMORY.md; the
    // candidate must surface as unresolved instead.
    expect(applied.applied).toBe(0);
  });

  it("does not promote replacement text through a comment-only stored anchor", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
      "intro",
      "summary",
      "Moved backups to S3 Glacier.",
      "Keep cold storage retention at 365 days.",
    ]);
    await recordMemoryRecalls(workspaceDir, "glacier", [
      memoryRecallResult("memory/2026-04-01.md", 3, 4, 0.94, "<!-- archived backup note -->"),
    ]);
    // A comment-only anchor normalizes away to nothing after comment
    // stripping. The recorded lines were later replaced by unrelated content,
    // so positional fallback at the recorded coordinates would promote that
    // replacement text; the candidate must surface as unresolved instead.
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
      "intro",
      "summary",
      "Moved backups to S3 Glacier.",
      "Unrelated replacement text now occupies the recorded lines.",
    ]);

    const ranked = await rankAllCandidates(workspaceDir);
    const applied = await applyAllCandidates(workspaceDir, ranked);

    expect(applied.applied).toBe(0);
  });
});
