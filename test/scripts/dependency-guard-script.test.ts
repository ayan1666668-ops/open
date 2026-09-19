import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GITHUB_ERROR_BODY_MAX_BYTES,
  GITHUB_RESPONSE_BODY_MAX_BYTES,
  canAutoscrubPullRequest,
  createAutoscrubCommit,
  dependencyGuardCommentAuthors,
  dependencyFieldChanges,
  githubApi,
  isAutoscrubbedDependencyComment,
  isDependencyFile,
  isDependencyGuardMarkerComment,
  isDependencyManifest,
  isPackageLockfile,
  isRemovalOnlyDependencyGraphChange,
  readBoundedGitHubErrorText,
  renderAutoscrubbedDependencyComment,
  renderBlockedDependencyComment,
  renderClearedDependencyGuardComment,
  renderRemovalOnlyDependencyComment,
  shouldAutoscrubDependencyLockfiles,
} from "../../scripts/github/dependency-guard.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const headSha = "a".repeat(40);
const staleSha = "b".repeat(40);

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const pullPath = "/repos/openclaw/openclaw/pulls/7";
const issuePath = "/repos/openclaw/openclaw/issues/7";
const pullRequest = {
  number: 7,
  state: "open",
  draft: false,
  changed_files: 1,
  user: { id: 1, login: "contributor", type: "User" },
  base: { ref: "main", sha: staleSha, repo: { id: 1, full_name: "openclaw/openclaw" } },
  head: { ref: "change", sha: headSha, repo: { id: 1, full_name: "openclaw/openclaw" } },
};
const approval = {
  id: 11,
  state: "APPROVED",
  commit_id: headSha,
  user: { id: 2, login: "maintainer", type: "User" },
};

function runDependencyGuard(routes: Record<string, unknown> = {}, mode = "enforce") {
  const dir = tempDirs.make("openclaw-dependency-guard-");
  const eventPath = path.join(dir, "event.json");
  const fixturePath = path.join(dir, "fixture.json");
  const logPath = path.join(dir, "requests.jsonl");
  const outputPath = path.join(dir, "output.txt");
  writeFileSync(outputPath, "");
  writeFileSync(eventPath, JSON.stringify({ pull_request: pullRequest }));
  writeFileSync(logPath, "");
  writeFileSync(
    fixturePath,
    JSON.stringify({
      logPath,
      routes: {
        [`GET ${pullPath}`]: pullRequest,
        [`GET ${pullPath}/files`]: [{ filename: "pnpm-workspace.yaml" }],
        [`GET ${pullPath}/reviews`]: [],
        [`GET ${issuePath}/comments`]: [],
        [`GET ${issuePath}/labels`]: [],
        "GET /repos/openclaw/openclaw/collaborators/contributor/permission": { role_name: "write" },
        "GET /repos/openclaw/openclaw/collaborators/maintainer/permission": {
          role_name: "maintain",
        },
        ...routes,
      },
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      fileURLToPath(new URL("../fixtures/github-guard-fetch.mjs", import.meta.url)),
      fileURLToPath(new URL("../../scripts/github/dependency-guard.mjs", import.meta.url)),
    ],
    {
      encoding: "utf8",
      env: {
        GITHUB_TOKEN: "fixture-token",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_RUN_ID: "1",
        GITHUB_OUTPUT: outputPath,
        OPENCLAW_GUARD_TEST_FIXTURE: fixturePath,
        OPENCLAW_DEPENDENCY_GUARD_MODE: mode,
        OPENCLAW_DEPENDENCY_GUARD_AUTOSCRUB_TOKEN: "fixture-autoscrub-token",
      },
    },
  );
  const calls: Array<{
    method: string;
    path: string;
    body?: { state?: string; body?: string; variables?: { input?: unknown } };
  }> = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return {
    ...result,
    calls,
    output: readFileSync(outputPath, "utf8"),
    statuses: calls.filter((call) => call.path.includes("/statuses/")),
  };
}

describe("dependency guard script", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["maintain", "admin"])("allows %s authors without organization membership", (role) => {
    const result = runDependencyGuard({
      "GET /repos/openclaw/openclaw/collaborators/contributor/permission": { role_name: role },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.statuses.map((call) => call.body?.state)).toEqual(["pending", "success"]);
    expect(result.stdout).toContain("informational");
  });

  it.each([
    { name: "current maintainer approval", reviews: [approval], role: "maintain", allowed: true },
    { name: "current admin approval", reviews: [approval], role: "admin", allowed: true },
    { name: "write-only reviewer", reviews: [approval], role: "write", allowed: false },
    {
      name: "stale review",
      reviews: [{ ...approval, commit_id: staleSha }],
      role: "maintain",
      allowed: false,
    },
    {
      name: "dismissed review",
      reviews: [{ ...approval, state: "DISMISSED" }],
      role: "maintain",
      allowed: false,
    },
    {
      name: "bot approval",
      reviews: [{ ...approval, user: { ...approval.user, type: "Bot" } }],
      role: "maintain",
      allowed: false,
    },
  ])("uses $name for an external dependency PR", ({ reviews, role, allowed }) => {
    const result = runDependencyGuard({
      [`GET ${pullPath}/reviews`]: reviews,
      "GET /repos/openclaw/openclaw/collaborators/maintainer/permission": { role_name: role },
      [`GET ${issuePath}/comments`]: [
        {
          id: 4,
          user: { login: "github-actions[bot]" },
          body: `<!-- openclaw:dependency-graph-guard -->\n<!-- openclaw:dependency-graph-guard state=authorized sha=${headSha} -->\n`,
        },
        { id: 5, user: approval.user, body: "/allow-dependencies-change" },
      ],
    });
    expect(result.status, result.stderr).toBe(allowed ? 0 : 1);
    expect(result.statuses.map((call) => call.body?.state)).toEqual([
      "pending",
      allowed ? "success" : "failure",
    ]);
    expect(result.stdout).toContain(
      allowed ? "Dependency graph changes approved" : "Maintainer dependency review required",
    );
  });

  it("rechecks a review before publishing dependency success", () => {
    const result = runDependencyGuard({
      [`GET ${pullPath}/reviews`]: {
        responses: [[approval], [{ ...approval, state: "DISMISSED" }]],
      },
    });
    expect(result.status).toBe(1);
    expect(result.statuses.at(-1)?.body?.state).toBe("failure");
    expect(result.stdout).toContain("Maintainer dependency review required");
  });

  it("requires review when a patch is renamed out of its protected directory", () => {
    const result = runDependencyGuard({
      [`GET ${pullPath}/files`]: [
        { filename: "archived.patch", previous_filename: "patches/package.patch" },
      ],
    });
    expect(result.status).toBe(1);
    expect(result.statuses.at(-1)?.body?.state).toBe("failure");
    expect(result.stdout).toContain("patches/package.patch");
  });

  it("requires review when unchanged manifest contents move to a new package", () => {
    const manifest = {
      type: "file",
      encoding: "base64",
      content: Buffer.from(JSON.stringify({ dependencies: { example: "1" } })).toString("base64"),
    };
    const result = runDependencyGuard({
      [`GET ${pullPath}/files`]: [
        {
          filename: "extensions/new/package.json",
          previous_filename: "extensions/old/package.json",
        },
      ],
      "GET /repos/openclaw/openclaw/contents/extensions/old/package.json": manifest,
      "GET /repos/openclaw/openclaw/contents/extensions/new/package.json": manifest,
      [`GET /repos/openclaw/openclaw/dependency-graph/compare/${staleSha}...${headSha}`]: [
        { change_type: "removed", name: "example", manifest: "extensions/old/package.json" },
      ],
    });
    expect(result.status).toBe(1);
    expect(result.statuses.at(-1)?.body?.state).toBe("failure");
    expect(result.stdout).toContain(
      "`extensions/old/package.json` moved to `extensions/new/package.json`",
    );
  });

  it("requires review for a renamed lockfile without scrubbing the contributor artifact", () => {
    const routes = {
      [`GET ${pullPath}/files`]: [
        { filename: "fixtures/old-lockfile.txt", previous_filename: "pnpm-lock.yaml" },
      ],
      [`GET /repos/openclaw/openclaw/dependency-graph/compare/${staleSha}...${headSha}`]: [
        { change_type: "removed", name: "example", manifest: "pnpm-lock.yaml" },
      ],
    };
    const detection = runDependencyGuard(routes, "detect");
    expect(detection.status, detection.stderr).toBe(0);
    expect(detection.output).toBe("autoscrub=false\n");
    expect(detection.calls.some((call) => call.path === "/graphql")).toBe(false);
    const enforcement = runDependencyGuard(routes);
    expect(enforcement.status).toBe(1);
    expect(enforcement.statuses.at(-1)?.body?.state).toBe("failure");
  });

  it("publishes success when a manifest changes only scripts", () => {
    const content = (scripts: unknown) => ({
      type: "file",
      encoding: "base64",
      content: Buffer.from(JSON.stringify({ scripts })).toString("base64"),
    });
    const result = runDependencyGuard({
      [`GET ${pullPath}/files`]: [{ filename: "package.json" }],
      "GET /repos/openclaw/openclaw/contents/package.json": {
        responses: [content({ test: "old" }), content({ test: "new" })],
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.statuses.at(-1)?.body?.state).toBe("success");
  });

  it.each([false, true])("preserves autoscrub with late approval=%s", (lateApproval) => {
    const result = runDependencyGuard(
      {
        [`GET ${pullPath}/files`]: [{ filename: "pnpm-lock.yaml" }],
        [`GET ${pullPath}/reviews`]: { responses: [[], lateApproval ? [approval] : []] },
        [`GET /repos/openclaw/openclaw/dependency-graph/compare/${staleSha}...${headSha}`]: [],
        "GET /repos/openclaw/openclaw/contents/pnpm-lock.yaml": {
          type: "file",
          encoding: "base64",
          content: Buffer.from("base lockfile").toString("base64"),
        },
        "POST /graphql": { data: { createCommitOnBranch: { commit: { oid: staleSha } } } },
      },
      "autoscrub",
    );
    expect(result.status, result.stderr).toBe(0);
    const writes = result.calls.filter((call) => call.path === "/graphql");
    expect(writes).toHaveLength(lateApproval ? 0 : 1);
    if (!lateApproval) {
      expect(writes[0]?.body?.variables?.input).toMatchObject({
        expectedHeadOid: headSha,
        fileChanges: {
          additions: [
            { path: "pnpm-lock.yaml", contents: Buffer.from("base lockfile").toString("base64") },
          ],
        },
      });
    }
    expect(result.statuses.map((call) => call.body?.state)).toEqual(["pending"]);
  });

  it("detects dependency guard file surfaces", () => {
    expect(isDependencyFile("pnpm-lock.yaml")).toBe(true);
    expect(isDependencyFile("package.json")).toBe(false);
    expect(isDependencyFile("ui/package.json")).toBe(false);
    expect(isDependencyFile("packages/core/package.json")).toBe(false);
    expect(isDependencyFile("qa/convex-credential-broker/package.json")).toBe(false);
    expect(isDependencyFile("package-lock.json")).toBe(true);
    expect(isDependencyFile("tools/nested/pnpm-lock.yaml")).toBe(true);
    expect(isDependencyFile("src/index.ts")).toBe(false);
    expect(isPackageLockfile("pnpm-lock.yaml")).toBe(true);
    expect(isPackageLockfile("package-lock.json")).toBe(true);
    expect(isPackageLockfile("package.json")).toBe(false);
  });

  it("compares package manifest fields that can affect dependency resolution", () => {
    expect(isDependencyManifest("package.json")).toBe(true);
    expect(isDependencyManifest("extensions/slack/package.json")).toBe(true);
    expect(isDependencyManifest("qa/convex-credential-broker/package.json")).toBe(true);
    expect(isDependencyManifest("src/index.ts")).toBe(false);
    expect(
      dependencyFieldChanges(
        { scripts: { test: "old" }, dependencies: { a: "1" } },
        { scripts: { test: "new" }, dependencies: { a: "1" } },
      ),
    ).toEqual([]);
    expect(
      dependencyFieldChanges(
        { dependencies: { a: "1" }, devDependencies: { b: "1" } },
        { dependencies: { a: "2" }, devDependencies: { b: "1", c: "1" } },
      ),
    ).toEqual(["dependencies", "devDependencies"]);
    expect(
      dependencyFieldChanges(
        {
          optionalDependencies: { a: "1" },
          peerDependencies: { b: "1" },
          overrides: { c: "1" },
          packageManager: "pnpm@10.0.0",
          pnpm: { patchedDependencies: { d: "patches/d.patch" } },
          scripts: { test: "old" },
        },
        {
          optionalDependencies: { a: "2" },
          peerDependencies: { b: "2" },
          overrides: { c: "2" },
          packageManager: "pnpm@10.1.0",
          pnpm: { patchedDependencies: { d: "patches/d2.patch" } },
          scripts: { test: "new" },
        },
      ),
    ).toEqual(["optionalDependencies", "peerDependencies", "overrides", "packageManager", "pnpm"]);
  });

  it("allows only dependency graph removals without approval", () => {
    expect(
      isRemovalOnlyDependencyGraphChange([
        { change_type: "removed", name: "a" },
        { change_type: "removed", name: "b" },
      ]),
    ).toBe(true);
    expect(
      isRemovalOnlyDependencyGraphChange([
        { change_type: "removed", name: "a" },
        { change_type: "added", name: "b" },
      ]),
    ).toBe(false);
    expect(isRemovalOnlyDependencyGraphChange([{ change_type: "changed", name: "a" }])).toBe(false);
    expect(isRemovalOnlyDependencyGraphChange([])).toBe(false);
  });

  it("renders dependency removals as informational", () => {
    const body = renderRemovalOnlyDependencyComment({
      dependencyGraphChanges: [
        {
          change_type: "removed",
          manifest: "extensions/example/package.json",
          name: "example-dependency",
        },
      ],
      headSha,
    });

    expect(body).toContain("Dependency removals noted");
    expect(body).toContain("does not require additional maintainer approval");
    expect(body).toContain("Removed `example-dependency`");
    expect(body).toContain("`extensions/example/package.json`");
    expect(body).toContain(headSha);
    expect(body).not.toContain("changes are blocked");
  });

  it("trusts only configured dependency guard marker comment authors", () => {
    const trustedAuthors = dependencyGuardCommentAuthors(
      "github-actions[bot], openclaw-autoscrub[bot]",
    );
    expect(dependencyGuardCommentAuthors(undefined)).toEqual(new Set(["github-actions[bot]"]));

    expect(
      isDependencyGuardMarkerComment(
        {
          body: "<!-- openclaw:dependency-graph-guard -->",
          user: { login: "openclaw-autoscrub[bot]" },
        },
        "<!-- openclaw:dependency-graph-guard -->",
        trustedAuthors,
      ),
    ).toBe(true);
    expect(
      isDependencyGuardMarkerComment(
        {
          body: "<!-- openclaw:dependency-graph-guard -->",
          user: { login: "contributor" },
        },
        "<!-- openclaw:dependency-graph-guard -->",
        trustedAuthors,
      ),
    ).toBe(false);
    expect(
      isDependencyGuardMarkerComment(
        {
          body: "no marker",
          user: { login: "github-actions[bot]" },
        },
        "<!-- openclaw:dependency-graph-guard -->",
        trustedAuthors,
      ),
    ).toBe(false);
  });

  it("renders deterministic removal guidance for blocked lockfile changes", () => {
    const body = renderBlockedDependencyComment({
      baseBranch: "main",
      headSha,
      lockfileChanges: ["pnpm-lock.yaml", "tools/nested/pnpm-lock.yaml"],
      dependencyManifestChanges: [
        {
          path: "package.json",
          fields: ["dependencies"],
        },
      ],
    });

    expect(body).toContain("<!-- openclaw:dependency-graph-guard -->");
    expect(body).toContain("Maintainer dependency review required");
    expect(body).toContain("`pnpm-lock.yaml` changed.");
    expect(body).toContain("`tools/nested/pnpm-lock.yaml` changed.");
    expect(body).toContain("`package.json` changed `dependencies`.");
    expect(body).toContain(
      "git checkout 'origin/main' -- 'pnpm-lock.yaml' 'tools/nested/pnpm-lock.yaml'",
    );
    expect(body).toContain("GitHub's normal review action");
    expect(body).toContain("SecOps approval is not required");
    expect(body).toContain(`Current head SHA: \`${headSha}\``);
    expect(body).toContain("A later push requires a fresh approval.");
  });

  it("shell-quotes PR-controlled paths in removal guidance", () => {
    const body = renderBlockedDependencyComment({
      baseBranch: "release/canary branch",
      headSha,
      lockfileChanges: [
        "dir with spaces/pnpm-lock.yaml",
        "safe/quote'$(touch bad);/package-lock.json",
      ],
      dependencyManifestChanges: [],
    });

    expect(body).toContain(
      "git checkout 'origin/release/canary branch' -- 'dir with spaces/pnpm-lock.yaml' 'safe/quote'\\''$(touch bad);/package-lock.json'",
    );
  });

  it("autoscrubs only lockfile changes with no dependency manifest changes", () => {
    expect(
      shouldAutoscrubDependencyLockfiles({
        dependencyFiles: ["pnpm-lock.yaml"],
        lockfileChanges: ["pnpm-lock.yaml"],
        dependencyManifestChanges: [],
      }),
    ).toBe(true);
    expect(
      shouldAutoscrubDependencyLockfiles({
        dependencyFiles: ["pnpm-lock.yaml"],
        lockfileChanges: ["pnpm-lock.yaml"],
        dependencyManifestChanges: [{ path: "package.json", fields: ["dependencies"] }],
      }),
    ).toBe(false);
    expect(
      shouldAutoscrubDependencyLockfiles({
        dependencyFiles: [],
        lockfileChanges: [],
        dependencyManifestChanges: [],
      }),
    ).toBe(false);
    expect(
      shouldAutoscrubDependencyLockfiles({
        dependencyFiles: ["pnpm-lock.yaml", "patches/example.patch"],
        lockfileChanges: ["pnpm-lock.yaml"],
        dependencyManifestChanges: [],
      }),
    ).toBe(false);
    expect(
      shouldAutoscrubDependencyLockfiles({
        dependencyFiles: ["pnpm-lock.yaml", "pnpm-workspace.yaml"],
        lockfileChanges: ["pnpm-lock.yaml"],
        dependencyManifestChanges: [],
      }),
    ).toBe(false);
  });

  it("attempts autoscrub on PR branches maintainers can modify", () => {
    const sameRepoPullRequest = {
      head: {
        ref: "contributor/change",
        repo: { full_name: "openclaw/openclaw" },
        sha: headSha,
      },
    };
    const forkPullRequest = {
      head: {
        ref: "contributor/change",
        repo: { full_name: "external/openclaw" },
        sha: headSha,
      },
    };
    const editableForkPullRequest = {
      maintainer_can_modify: true,
      head: {
        ref: "contributor/change",
        repo: { full_name: "external/openclaw" },
        sha: headSha,
      },
    };

    expect(
      canAutoscrubPullRequest({
        owner: "openclaw",
        repo: "openclaw",
        pullRequest: sameRepoPullRequest,
      }),
    ).toBe(true);
    expect(
      canAutoscrubPullRequest({
        owner: "openclaw",
        repo: "openclaw",
        pullRequest: forkPullRequest,
      }),
    ).toBe(false);
    expect(
      canAutoscrubPullRequest({
        owner: "openclaw",
        repo: "openclaw",
        pullRequest: editableForkPullRequest,
      }),
    ).toBe(true);
  });

  it("renders deterministic autoscrub success comments", () => {
    const body = renderAutoscrubbedDependencyComment({
      baseBranch: "main",
      commitSha: staleSha,
      lockfileChanges: ["pnpm-lock.yaml", "tools/nested/pnpm-lock.yaml"],
    });

    expect(body).toContain("<!-- openclaw:dependency-graph-guard -->");
    expect(body).toContain("Dependency lockfile changes were removed");
    expect(body).toContain("did not change dependency graph fields in package manifests");
    expect(body).toContain("`pnpm-lock.yaml`");
    expect(body).toContain("`tools/nested/pnpm-lock.yaml`");
    expect(body).toContain(`Cleanup commit: \`${staleSha}\``);
    expect(body).toContain(
      "restored each listed lockfile from the target branch and pushed the cleanup commit to this PR head",
    );
    expect(body).toContain(
      "this PR no longer carries those package lockfile diffs after the cleanup commit",
    );
    expect(isAutoscrubbedDependencyComment({ body })).toBe(true);
  });

  it("renders fork and dependency-manifest autoscrub guidance", () => {
    const forkBody = renderBlockedDependencyComment({
      baseBranch: "main",
      headSha,
      lockfileChanges: ["pnpm-lock.yaml"],
      dependencyManifestChanges: [],
      autoscrubStatus: { kind: "not-attempted" },
    });
    const unsafeBody = renderBlockedDependencyComment({
      baseBranch: "main",
      headSha,
      lockfileChanges: ["pnpm-lock.yaml"],
      dependencyManifestChanges: [],
      autoscrubStatus: {
        kind: "blocked-by-dependency-manifest-fields",
        changes: [{ path: "package.json", fields: ["dependencies"] }],
      },
    });
    const mixedBody = renderBlockedDependencyComment({
      baseBranch: "main",
      headSha,
      lockfileChanges: ["pnpm-lock.yaml"],
      dependencyManifestChanges: [],
      autoscrubStatus: {
        kind: "blocked-by-other-dependency-files",
        files: ["patches/example.patch", "pnpm-workspace.yaml"],
      },
    });

    expect(forkBody).toContain("Auto-scrub was not attempted");
    expect(forkBody).toContain(
      "only push deterministic cleanup commits to PR branches that maintainers can modify",
    );
    expect(unsafeBody).toContain("changes package manifest dependency graph fields");
    expect(unsafeBody).toContain("`package.json` changed `dependencies`");
    expect(unsafeBody).toContain("Dependency graph changes require maintainer review");
    expect(mixedBody).toContain("also changes dependency-related files");
    expect(mixedBody).toContain("`patches/example.patch`");
    expect(mixedBody).toContain("`pnpm-workspace.yaml`");
  });

  it("reads base lockfiles with the base API before writing autoscrub commits", async () => {
    const calls: Array<{ api: string; path: string; variables?: unknown }> = [];
    const baseApi = {
      request: async (requestPath: string) => {
        calls.push({ api: "base", path: requestPath });
        if (requestPath.includes("/contents/pnpm-lock.yaml?")) {
          return {
            content: Buffer.from("base lockfile").toString("base64"),
            encoding: "base64",
            sha: "base-file",
            type: "file",
          };
        }
        throw new Error(`unexpected base request: ${requestPath}`);
      },
    };
    const writeApi = {
      graphql: async (_query: string, variables: unknown) => {
        calls.push({ api: "write", path: "graphql", variables });
        return { createCommitOnBranch: { commit: { oid: staleSha } } };
      },
    };

    const autoscrubPullRequest = {
      user: { id: 1, login: "contributor", type: "User" },
      base: { sha: "base-sha" },
      head: { ref: "contributor/change", sha: headSha },
    };
    const guard = {
      owner: "openclaw",
      repo: "openclaw",
      pullRequest: autoscrubPullRequest,
      pullPath: "/repos/openclaw/openclaw/pulls/1",
      api: {
        request: async (requestPath: string) =>
          requestPath.endsWith("/permission") ? { role_name: "read" } : autoscrubPullRequest,
        paginate: async () => [],
      },
    };
    const commit = await createAutoscrubCommit(
      { baseApi, writeApi, guard },
      {
        owner: "openclaw",
        repo: "openclaw",
        pullRequest: autoscrubPullRequest,
        lockfileChanges: ["pnpm-lock.yaml"],
        targetRepository: { owner: "contributor", repo: "openclaw" },
      },
    );

    expect(commit).toEqual({ sha: staleSha });
    expect(calls.map((call) => `${call.api}:${call.path}`)).toEqual([
      "base:/repos/openclaw/openclaw/contents/pnpm-lock.yaml?ref=base-sha",
      "write:graphql",
    ]);
    expect(calls[1]?.variables).toMatchObject({
      input: {
        branch: {
          repositoryNameWithOwner: "contributor/openclaw",
          branchName: "contributor/change",
        },
        expectedHeadOid: headSha,
        fileChanges: {
          additions: [
            {
              contents: Buffer.from("base lockfile").toString("base64"),
              path: "pnpm-lock.yaml",
            },
          ],
          deletions: [],
        },
      },
    });
  });

  it("renders a cleared guard comment that preserves approval freshness", () => {
    const body = renderClearedDependencyGuardComment({ headSha });

    expect(body).toContain("<!-- openclaw:dependency-graph-guard -->");
    expect(body).toContain("Dependency graph guard cleared");
    expect(body).toContain(headSha);
    expect(body).toContain("requires a maintainer's normal GitHub approval");
  });

  it("bounds GitHub error bodies by content-length", async () => {
    const response = new Response("ignored", {
      headers: { "content-length": String(GITHUB_ERROR_BODY_MAX_BYTES + 1) },
    });

    await expect(readBoundedGitHubErrorText(response)).rejects.toThrow(
      `GitHub error response body exceeded ${GITHUB_ERROR_BODY_MAX_BYTES} bytes`,
    );
  });

  it("bounds GitHub error bodies by streamed bytes", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(GITHUB_ERROR_BODY_MAX_BYTES + 1));
          controller.close();
        },
      }),
    );

    await expect(readBoundedGitHubErrorText(response)).rejects.toThrow(
      `GitHub error response body exceeded ${GITHUB_ERROR_BODY_MAX_BYTES} bytes`,
    );
  });

  it("preserves GitHub status when an error body exceeds the cap", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(GITHUB_ERROR_BODY_MAX_BYTES + 1));
              controller.close();
            },
          }),
          { status: 403, statusText: "Forbidden" },
        ),
      )) as typeof fetch;

    try {
      await expect(githubApi("token").request("/repos/openclaw/openclaw")).rejects.toMatchObject({
        message: `403 Forbidden: GitHub error response body exceeded ${GITHUB_ERROR_BODY_MAX_BYTES} bytes`,
        status: 403,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries transient GitHub API failures within the request timeout", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unicorn", { status: 503, statusText: "Unavailable" }))
      .mockResolvedValueOnce(Response.json({ ok: true }));

    await expect(
      githubApi("token", { fetchImpl, retryDelaysMs: [0] }).request(
        "/repos/openclaw/openclaw/pulls/1/files",
      ),
    ).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-idempotent GitHub API requests", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("unicorn", { status: 503, statusText: "Unavailable" }));

    await expect(
      githubApi("token", { fetchImpl, retryDelaysMs: [0] }).request(
        "/repos/openclaw/openclaw/issues/1/comments",
        { method: "POST", body: "{}" },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("bounds successful GitHub API response bodies", async () => {
    const request = githubApi("token", {
      responseMaxBodyBytes: 64,
      fetchImpl: (() =>
        Promise.resolve(
          new Response("x".repeat(65), {
            headers: { "content-length": "65" },
          }),
        )) as typeof fetch,
    }).request("/repos/openclaw/openclaw");

    await expect(request).rejects.toThrow("GitHub response body exceeded 64 bytes");
    expect(GITHUB_RESPONSE_BODY_MAX_BYTES).toBeGreaterThan(64);
  });

  it("aborts stalled GitHub API fetches at the request timeout", async () => {
    let signal: AbortSignal | undefined;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });

    vi.useFakeTimers();
    const request = githubApi("token", {
      timeoutMs: 5,
      fetchImpl: ((_url, init) => {
        signal = init?.signal ?? undefined;
        markFetchStarted();
        return new Promise(() => {});
      }) as typeof fetch,
    }).request("/repos/openclaw/openclaw");
    const rejection = expect(request).rejects.toThrow(
      /GitHub API GET \/repos\/openclaw\/openclaw exceeded timeout 5ms/u,
    );

    await fetchStarted;
    await vi.advanceTimersByTimeAsync(5);

    await rejection;
    expect(signal?.aborted).toBe(true);
  });

  it("keeps the GitHub API timeout active while reading response bodies", async () => {
    let signal: AbortSignal | undefined;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });

    vi.useFakeTimers();
    const request = githubApi("token", {
      timeoutMs: 5,
      fetchImpl: ((_url, init) => {
        signal = init?.signal ?? undefined;
        markFetchStarted();
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start() {},
            }),
            { headers: { "content-type": "application/json" } },
          ),
        );
      }) as typeof fetch,
    }).request("/repos/openclaw/openclaw");
    const rejection = expect(request).rejects.toThrow(
      /GitHub API GET \/repos\/openclaw\/openclaw exceeded timeout 5ms/u,
    );

    await fetchStarted;
    await vi.advanceTimersByTimeAsync(5);

    await rejection;
    expect(signal?.aborted).toBe(true);
  });
});
