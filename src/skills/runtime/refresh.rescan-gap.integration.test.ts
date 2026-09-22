import { AsyncLocalStorage } from "node:async_hooks";
import nativeFs from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import chokidar from "chokidar";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveSkillsWatcherUsePolling } from "./refresh-watch-path.js";

vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

it.runIf(
  process.platform === "linux" && !process.versions.bun && !resolveSkillsWatcherUsePolling(),
)("keeps native coverage for a sibling created during a replacement root scan", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skills-rescan-")));
  const workspaceDir = path.join(root, "workspace");
  const skillsRoot = path.join(workspaceDir, "skills");
  const firstDir = path.join(skillsRoot, "first");
  const secondDir = path.join(skillsRoot, "second");
  const skillFile = path.join(secondDir, "SKILL.md");
  await fs.mkdir(skillsRoot, { recursive: true });
  const { ensureSkillsWatcher, closeSkillsWatchers } = await import("./refresh.js");
  const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
  const read = () =>
    loadWorkspaceSkills(workspaceDir, {
      config: {},
      bundledSkillsDir: "",
      managedSkillsDir: path.join(root, "unused"),
    }).map((entry) => entry.skill.name);

  const generation = new AsyncLocalStorage<number>();
  const releaseScan = createDeferredCore();
  const watches: Array<{ ready: boolean; watcher: ReturnType<typeof chokidar.watch> }> = [];
  const errors: unknown[] = [];
  let contentGeneration = 0;
  let snapshotCaptured = false;
  let snapshotContainsSecond = false;
  let nativeCreationObserved = false;
  const originalWatch = chokidar.watch;
  const watch = vi.spyOn(chokidar, "watch").mockImplementation((...args) => {
    const isContentRoot = args[0] === skillsRoot && (args[1]?.depth ?? 0) > 0;
    const id = isContentRoot ? ++contentGeneration : 0;
    return generation.run(id, () => {
      const watcher = originalWatch(...args);
      const observation = { ready: false, watcher };
      watches.push(observation);
      watcher.once("ready", () => {
        observation.ready = true;
      });
      watcher.on("error", (error) => errors.push(error));
      return watcher;
    });
  });
  const originalReaddir = fs.readdir;
  const readdir = vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
    const entries = await originalReaddir(...args);
    if (
      generation.getStore() === 2 &&
      path.resolve(String(args[0])) === skillsRoot &&
      !snapshotCaptured
    ) {
      // Preserve the real root listing, then create a sibling before this scan
      // can install its native watch. Only the observing generation can see it.
      snapshotContainsSecond = entries.some((entry) => String(entry.name) === "second");
      snapshotCaptured = true;
      await releaseScan.promise;
    }
    return entries;
  });
  syncBuiltinESMExports();
  let observation: ReturnType<typeof nativeFs.watch> | undefined;

  try {
    observation = nativeFs.watch(skillsRoot, (_event, filename) => {
      if (String(filename) === "second") {
        nativeCreationObserved = true;
      }
    });
    ensureSkillsWatcher({ workspaceDir, config: {} });
    await vi.waitFor(() => {
      expect(contentGeneration).toBe(1);
      expect(watches.every(({ ready, watcher }) => ready || watcher.closed)).toBe(true);
      expect(errors).toEqual([]);
    });
    expect(read()).toEqual([]);
    nativeFs.mkdirSync(firstDir);
    await expect.poll(() => snapshotCaptured, { timeout: 3_000 }).toBe(true);
    expect(snapshotContainsSecond).toBe(false);

    nativeFs.mkdirSync(secondDir);
    nativeFs.writeFileSync(
      skillFile,
      "---\nname: rescan-proof\ndescription: Native rescan coverage\n---\n",
    );
    // This independent observation establishes that the real OS event occurred
    // before scan release; it never forwards events to the product watcher.
    await expect.poll(() => nativeCreationObserved, { timeout: 3_000 }).toBe(true);
    releaseScan.resolve();
    await vi.waitFor(() => {
      expect(watches.every(({ ready, watcher }) => ready || watcher.closed)).toBe(true);
      expect(errors).toEqual([]);
    });
    await expect.poll(read, { timeout: 3_000 }).toEqual(["rescan-proof"]);

    // A ready-time inventory alone discovers the sibling, but cannot observe
    // later changes inside it unless the replacement has native coverage.
    nativeFs.renameSync(skillFile, path.join(secondDir, "SKILL.saved"));
    await expect.poll(read, { timeout: 3_000 }).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    releaseScan.resolve();
    observation?.close();
    try {
      await closeSkillsWatchers(true);
    } finally {
      readdir.mockRestore();
      watch.mockRestore();
      syncBuiltinESMExports();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});
