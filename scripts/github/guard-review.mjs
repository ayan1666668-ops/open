import { readFile } from "node:fs/promises";
import { createGitHubApi } from "./guard-shared.mjs";

const requestMarker = "<!-- openclaw:approval-request ";
const approvalCommands = new Set([
  "/allow-security-sensitive-change",
  "/allow-dependencies-change",
]);

function pullRequestNumber(event) {
  if (event.pull_request) {
    return event.pull_request.number;
  }
  if (event.issue?.pull_request && event.comment) {
    return event.issue.number;
  }
  if (/^[1-9][0-9]*$/u.test(event.inputs?.pr_number ?? "")) {
    return Number(event.inputs.pr_number);
  }
  return null;
}

function snapshot(pr) {
  return JSON.stringify([
    pr.number,
    pr.state,
    pr.draft,
    pr.user?.id,
    pr.user?.login,
    pr.user?.type,
    pr.base?.repo?.id,
    pr.base?.ref,
    pr.base?.sha,
    pr.head?.repo?.id,
    pr.head?.ref,
    pr.head?.sha,
    pr.maintainer_can_modify,
    pr.changed_files,
  ]);
}

export async function assertGuardUnchanged(guard) {
  const current = await guard.api.request(guard.pullPath);
  if (snapshot(current) !== snapshot(guard.pullRequest)) {
    throw new Error("The pull request changed during security review. Rerun the guard.");
  }
  return current;
}

async function publishStatus(guard, state, description) {
  await guard.api.request(
    `/repos/${guard.owner}/${guard.repo}/statuses/${guard.pullRequest.head.sha}`,
    {
      method: "POST",
      body: JSON.stringify({
        context: guard.context,
        state,
        description,
        target_url: guard.runUrl,
      }),
    },
  );
}

export async function openGuard({ context, commentMarker, approvalCommand }) {
  const { GITHUB_TOKEN, GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_EVENT_PATH || !GITHUB_REPOSITORY) {
    throw new Error("GITHUB_TOKEN, GITHUB_EVENT_PATH, and GITHUB_REPOSITORY are required.");
  }
  const event = JSON.parse(await readFile(GITHUB_EVENT_PATH, "utf8"));
  const number = pullRequestNumber(event);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error("No valid pull request in the guard event.");
  }
  const [owner, repo] = GITHUB_REPOSITORY.split("/");
  const api = createGitHubApi(GITHUB_TOKEN, { userAgent: "openclaw-security-review" });
  const pullPath = `/repos/${owner}/${repo}/pulls/${number}`;
  const pullRequest = await api.request(pullPath);
  if (pullRequest.state !== "open" || pullRequest.draft) {
    return null;
  }
  const guard = {
    api,
    owner,
    repo,
    event,
    pullRequest,
    pullPath,
    issuePath: `/repos/${owner}/${repo}/issues/${number}`,
    context,
    commentMarker,
    approvalCommand,
    runUrl: `https://github.com/${owner}/${repo}/actions/runs/${GITHUB_RUN_ID}`,
  };
  // Replace any previous green result before reading files or authority. A failed
  // API request must leave the current revision waiting, never implicitly approved.
  await publishStatus(guard, "pending", "Checking sensitive changes and maintainer review");
  const files = await api.paginate(`${pullPath}/files`);
  if (files.length !== pullRequest.changed_files) {
    throw new Error(
      "GitHub did not return the complete changed-file list. Split the PR and retry.",
    );
  }
  await assertGuardUnchanged(guard);
  return { ...guard, files };
}

async function maintainerRole(guard, user) {
  if (user?.type !== "User" || !user.login) {
    return null;
  }
  let permission;
  try {
    permission = await guard.api.request(
      `/repos/${guard.owner}/${guard.repo}/collaborators/${encodeURIComponent(user.login)}/permission`,
    );
  } catch (error) {
    if (error?.status === 404) {
      return null;
    }
    throw error;
  }
  return permission.role_name === "maintain" || permission.role_name === "admin"
    ? permission.role_name
    : null;
}

function approvalRequest(guard, comments) {
  const current = { head: guard.pullRequest.head.sha, base: guard.pullRequest.base.ref };
  const notice = comments.find(
    (comment) =>
      comment.user?.type === "Bot" &&
      comment.user.login === "github-actions[bot]" &&
      comment.body?.startsWith(`${guard.commentMarker}\n`),
  );
  const line = notice?.body?.split("\n")[1];
  if (!line?.startsWith(requestMarker) || !line.endsWith(" -->")) {
    return current;
  }
  let recorded;
  try {
    recorded = JSON.parse(line.slice(requestMarker.length, -4));
  } catch {
    return current;
  }
  if (recorded?.head !== current.head || recorded?.base !== current.base) {
    return current;
  }
  // The first notice for a revision has no timestamp. On the next evaluation,
  // freeze GitHub's update time before rewriting the sticky notice. A queued
  // comment can never be rebound to a head first observed after it was posted.
  const requestedAt = recorded.requestedAt ?? notice.updated_at;
  const since = Date.parse(requestedAt);
  const updatedAt = Date.parse(notice.updated_at);
  if (!Number.isFinite(since) || !Number.isFinite(updatedAt) || since > updatedAt) {
    return current;
  }
  return { ...current, requestedAt };
}

export function withApprovalRequest(guard, body) {
  if (!guard.approvalRequest) {
    return body;
  }
  const record = JSON.stringify(guard.approvalRequest)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
  return `${guard.commentMarker}\n${requestMarker}${record} -->${body.slice(guard.commentMarker.length)}`;
}

export async function findMaintainerApproval(guard) {
  const { pullRequest } = guard;
  const sha = pullRequest.head.sha;
  const authorRole = await maintainerRole(guard, pullRequest.user);
  if (authorRole) {
    return { kind: "author", login: pullRequest.user.login, role: authorRole, sha };
  }
  const comments = await guard.api.paginate(`${guard.issuePath}/comments`);
  guard.approvalRequest = approvalRequest(guard, comments);
  const since = Date.parse(guard.approvalRequest.requestedAt);
  if (!Number.isFinite(since)) {
    return null;
  }
  for (const comment of comments.toReversed()) {
    const lines = (comment.body ?? "")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    if (
      !lines.includes(guard.approvalCommand) ||
      !lines.every((line) => approvalCommands.has(line)) ||
      !(Date.parse(comment.created_at) > since) ||
      comment.updated_at !== comment.created_at ||
      comment.user?.id === pullRequest.user.id
    ) {
      continue;
    }
    const role = await maintainerRole(guard, comment.user);
    if (role) {
      return { kind: "comment", login: comment.user.login, role, sha, url: comment.html_url };
    }
  }
  return null;
}

export async function finishGuard(guard, { description, requiresApproval = false }) {
  const approval = requiresApproval ? await findMaintainerApproval(guard) : null;
  await assertGuardUnchanged(guard);
  const allowed = !requiresApproval || approval !== null;
  await publishStatus(
    guard,
    allowed ? "success" : "failure",
    allowed ? description : "A maintainer must approve the current PR revision",
  );
  guard.approval = approval;
  return allowed;
}
