import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSecurityReviewPolicy } from "../../scripts/github/security-review-policy.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const headSha = "a".repeat(40);
const author = { id: 1, login: "contributor", type: "User" };
const reviewer = { id: 2, login: "maintainer", type: "User" };
const pullPath = "/repos/openclaw/openclaw/pulls/7";
const approval = { id: 1, user: reviewer, state: "APPROVED", commit_id: headSha };
const { collectSecuritySensitiveChanges } = loadSecurityReviewPolicy();

type Options = {
  authorRole?: string;
  reviewerRole?: string;
  authorType?: string;
  reviews?: object[];
  files?: object[];
  comments?: object[];
  event?: object;
  routes?: Record<string, unknown>;
  changedFiles?: number;
  policy?: string;
  script?: "security-sensitive-guard" | "dependency-guard";
};

function runGuard(options: Options = {}) {
  const root = tempDirs.make("security-sensitive-guard-");
  const eventPath = path.join(root, "event.json");
  const logPath = path.join(root, "requests.jsonl");
  const fixturePath = path.join(root, "fixture.json");
  const files = options.files ?? [{ filename: "src/gateway/auth.ts", status: "modified" }];
  const pr = {
    number: 7,
    state: "open",
    draft: false,
    user: { ...author, type: options.authorType ?? "User" },
    changed_files: options.changedFiles ?? files.length,
    head: { sha: headSha, ref: "change", repo: { id: 2 } },
    base: { sha: "b".repeat(40), ref: "main", repo: { id: 1 } },
  };
  const routes = {
    [`GET ${pullPath}`]: pr,
    [`GET ${pullPath}/files`]: files,
    [`GET ${pullPath}/reviews`]: options.reviews ?? [],
    "GET /repos/openclaw/openclaw/issues/7/comments": options.comments ?? [],
    "GET /repos/openclaw/openclaw/issues/7/labels": [],
    "GET /repos/openclaw/openclaw/collaborators/contributor/permission": {
      role_name: options.authorRole ?? "read",
    },
    "GET /repos/openclaw/openclaw/collaborators/maintainer/permission": {
      role_name: options.reviewerRole ?? "maintain",
    },
    ...options.routes,
  };
  writeFileSync(eventPath, JSON.stringify(options.event ?? { pull_request: pr }));
  writeFileSync(fixturePath, JSON.stringify({ routes, logPath }));
  writeFileSync(logPath, "");
  const script = options.script ?? "security-sensitive-guard";
  let scriptPath = path.resolve(`scripts/github/${script}.mjs`);
  if (options.policy !== undefined) {
    // Exercise policy edits in a separate trusted checkout without modifying the
    // shared source tree or adding a production-only-for-tests policy override.
    for (const source of [
      "scripts/github/security-sensitive-guard.mjs",
      "scripts/github/dependency-guard.mjs",
      "scripts/github/security-review-policy.mjs",
      "scripts/github/guard-review.mjs",
      "scripts/github/guard-shared.mjs",
      "scripts/lib/bounded-response.mjs",
    ]) {
      const target = path.join(root, source);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
    mkdirSync(path.join(root, ".github"));
    writeFileSync(path.join(root, ".github/security-review-policy.yml"), options.policy);
    symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
    scriptPath = realpathSync(path.join(root, `scripts/github/${script}.mjs`));
  }
  const result = spawnSync(
    process.execPath,
    ["--import", path.resolve("test/fixtures/github-guard-fetch.mjs"), scriptPath],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GITHUB_TOKEN: "fixture-token",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_RUN_ID: "123",
        OPENCLAW_GUARD_TEST_FIXTURE: fixturePath,
      },
    },
  );
  const requests = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          method: string;
          path: string;
          body?: { state?: string; context?: string; body?: string; labels?: string[] };
        },
    );
  return {
    ...result,
    requests,
    statuses: requests
      .filter((request) => request.path.includes("/statuses/"))
      .map((request) => request.body?.state),
    comment: requests.find(
      (request) => request.method === "POST" && request.path.endsWith("/comments"),
    )?.body?.body,
  };
}

describe("security-sensitive guard entry point", () => {
  it.each(["maintain", "admin"])("allows a %s author without extra approval", (authorRole) => {
    const result = runGuard({ authorRole });
    expect(result.status, result.stderr).toBe(0);
    expect(result.statuses).toEqual(["pending", "success"]);
    expect(result.comment).toContain("Informational");
  });

  it.each([
    { name: "an external author", options: {} },
    { name: "write access", options: { authorRole: "write" } },
    { name: "an admin bot", options: { authorRole: "admin", authorType: "Bot" } },
    { name: "a stale review", options: { reviews: [{ ...approval, commit_id: "c".repeat(40) }] } },
    { name: "a write-only reviewer", options: { reviews: [approval], reviewerRole: "write" } },
    {
      name: "a bot reviewer",
      options: { reviews: [{ ...approval, user: { ...reviewer, type: "Bot" } }] },
    },
    { name: "a dismissed review", options: { reviews: [{ ...approval, state: "DISMISSED" }] } },
    {
      name: "a later request for changes",
      options: { reviews: [approval, { ...approval, id: 2, state: "CHANGES_REQUESTED" }] },
    },
    {
      name: "a removed maintainer",
      options: {
        reviews: [approval],
        routes: {
          "GET /repos/openclaw/openclaw/collaborators/maintainer/permission": { httpError: 404 },
        },
      },
    },
    {
      name: "an old authorized bot comment",
      options: {
        comments: [
          {
            id: 4,
            user: { login: "github-actions[bot]" },
            body: `<!-- openclaw:security-sensitive-guard -->\n### Security-sensitive change authorized\nApproved SHA: \`${headSha}\``,
          },
        ],
      },
    },
  ])("requires review for $name", ({ options }) => {
    const result = runGuard(options);
    expect(result.status).toBe(1);
    expect(result.statuses).toEqual(["pending", "failure"]);
    expect(result.stderr).toContain("A maintainer must approve");
    expect(
      result.requests.some((request) => request.body?.labels?.includes("security-review-required")),
    ).toBe(true);
  });

  it.each(["maintain", "admin"])(
    "accepts normal current-head approval by a %s reviewer",
    (reviewerRole) => {
      const result = runGuard({ reviews: [approval], reviewerRole });
      expect(result.status, result.stderr).toBe(0);
      expect(result.statuses).toEqual(["pending", "success"]);
      expect(result.comment).toContain("@maintainer approved");
      expect(
        result.requests
          .filter((request) => request.path.includes("/statuses/"))
          .every((request) => request.path.endsWith(headSha)),
      ).toBe(true);
    },
  );

  it("does not treat a later review comment as a revoked approval", () => {
    const result = runGuard({ reviews: [approval, { ...approval, id: 2, state: "COMMENTED" }] });
    expect(result.status, result.stderr).toBe(0);
  });

  it("reevaluates fork reviews using the signal only as a PR locator", () => {
    const result = runGuard({
      event: {
        workflow_run: {
          name: "Security review events",
          event: "pull_request_review",
          display_title: "PR 7",
          pull_requests: [],
        },
      },
      reviews: [approval],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.statuses.at(-1)).toBe("success");
  });

  it("does not grant approval from signal metadata", () => {
    const result = runGuard({
      event: {
        workflow_run: {
          name: "Security review events",
          event: "pull_request_review",
          display_title: "PR 7",
          conclusion: "success",
          actor: reviewer,
        },
      },
    });
    expect(result.statuses).toEqual(["pending", "failure"]);
  });

  it.each([
    { reviews: [], expected: "failure" },
    { reviews: [approval], expected: "success" },
  ])(
    "refreshes policy from a dispatch without granting approval: $expected",
    ({ reviews, expected }) => {
      const result = runGuard({ event: { inputs: { pr_number: "7" } }, reviews });
      expect(result.statuses).toEqual(["pending", expected]);
    },
  );

  it("rejects invalid dispatch PR numbers before making requests", () => {
    const result = runGuard({ event: { inputs: { pr_number: "7/../../issues" } } });
    expect(result.status).toBe(1);
    expect(result.requests).toEqual([]);
  });

  it("fails closed when role verification is unavailable", () => {
    const result = runGuard({
      routes: {
        "GET /repos/openclaw/openclaw/collaborators/contributor/permission": { httpError: 403 },
      },
    });
    expect(result.status).toBe(1);
    expect(result.statuses).toEqual(["pending"]);
  });

  it("refuses incomplete changed-file lists", () => {
    const result = runGuard({ changedFiles: 3001 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("complete changed-file list");
    expect(result.statuses).toEqual(["pending"]);
  });

  it("refuses success if the PR changes after approval is read", () => {
    const pr = {
      number: 7,
      state: "open",
      draft: false,
      user: author,
      changed_files: 1,
      head: { sha: headSha, ref: "change", repo: { id: 2 } },
      base: { sha: "b".repeat(40), ref: "main", repo: { id: 1 } },
    };
    const result = runGuard({
      reviews: [approval],
      routes: {
        [`GET ${pullPath}`]: {
          responses: [pr, pr, { ...pr, head: { ...pr.head, sha: "c".repeat(40) } }],
        },
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pull request changed");
    expect(result.statuses).toEqual(["pending"]);
  });

  it("leaves hard-tier approval to CODEOWNERS and ignores ordinary changes", () => {
    const result = runGuard({ files: [{ filename: "SECURITY.md" }, { filename: "src/utils.ts" }] });
    expect(result.status, result.stderr).toBe(0);
    expect(result.statuses).toEqual(["pending", "success"]);
    expect(result.comment).toBeUndefined();
  });

  describe("trusted YAML policy", () => {
    const policy = `
exclude: {}
categories:
  custom:
    description: Custom protected responsibility.
    review: Inspect this responsibility carefully.
    paths: ["custom/product.ts"]
dependencies:
  manifests: ["**/package.json"]
  lockfiles: ["**/pnpm-lock.yaml"]
  other: ["custom/dependency-policy"]
`;

    it.each([
      { script: "security-sensitive-guard" as const, filename: "custom/product.ts" },
      { script: "dependency-guard" as const, filename: "custom/dependency-policy" },
    ])(
      "$script reads changed classification from YAML beside its checkout",
      ({ script, filename }) => {
        const result = runGuard({ script, policy, files: [{ filename }] });
        expect(result.statuses).toEqual(["pending", "failure"]);
        expect(result.comment).toContain("custom/");
      },
    );

    it.each(["security-sensitive-guard", "dependency-guard"] as const)(
      "%s cannot preserve an old success when YAML is invalid",
      (script) => {
        for (const invalidPolicy of ["categories: [", policy.replace("paths:", "pathz:")]) {
          const result = runGuard({ script, policy: invalidPolicy });
          expect(result.status).toBe(1);
          expect(result.statuses).toEqual(["pending"]);
          expect(result.stderr).toContain("Invalid security-review-policy.yml");
        }
      },
    );
  });
});

describe("sensitive change classification", () => {
  it.each([
    "src/gateway/auth.ts",
    "src/gateway/operator-scopes.ts",
    "src/gateway/origin-check.ts",
    "src/gateway/server/ws-origin-policy.ts",
    "src/gateway/methods/core-method-policy.ts",
    "src/gateway/session-method-policy.ts",
    "src/shared/operator-scope-compat.ts",
    "src/shared/device-bootstrap-profile.ts",
    "src/shared/gateway-method-policy.ts",
    "src/shared/session-method-scopes.ts",
    "src/infra/device-bootstrap.ts",
    "src/agents/agent-tools.policy.ts",
    "src/gateway/server/ws-connection/message-handler.ts",
    "src/secrets/resolve.ts",
    "src/secrets/.hidden-store/key.ts",
    "src/gateway/.internal/auth.ts",
    "src/agents/auth-profiles/store.ts",
    "src/agents/sandbox/docker.ts",
    "src/infra/exec-approvals.ts",
    ".gitignore",
  ])("explains the security responsibility of %s", (filename) => {
    const changes = collectSecuritySensitiveChanges([{ filename }]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ path: filename, reason: expect.any(String) });
    expect(changes[0]?.reason.length).toBeGreaterThan(40);
  });

  it("detects moving an owned file into an unclassified path without flagging tests or docs", () => {
    const changes = collectSecuritySensitiveChanges([
      { filename: "src/renamed.ts", previous_filename: "src/gateway/auth.ts" },
      { filename: "src/gateway/auth.test.ts" },
      { filename: "docs/gateway/authentication.md" },
    ]);
    expect(changes.map((change) => change.path)).toEqual(["src/gateway/auth.ts"]);
  });

  it("preserves exclusion boundaries and case sensitivity", () => {
    const changes = collectSecuritySensitiveChanges([
      "src/secrets/nested/TEST/store.ts",
      "src/secrets/store.MD",
      "src/secrets/store.test.ts",
      "src/secrets/nested-fixtures/store.ts",
      "src/secrets/store.TEST.ts",
      "src/secrets/fixtureless-store.ts",
    ]);
    expect(changes.map((change) => change.path)).toEqual([
      "src/secrets/fixtureless-store.ts",
      "src/secrets/store.TEST.ts",
    ]);
  });
});
