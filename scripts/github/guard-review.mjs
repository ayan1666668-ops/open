import { readFile } from "node:fs/promises";
import { createGitHubApi } from "./guard-shared.mjs";

function pullRequestNumber(event) {
  if (event.pull_request) {
    return event.pull_request.number;
  }
  if (/^[1-9][0-9]*$/u.test(event.inputs?.pr_number ?? "")) {
    return Number(event.inputs.pr_number);
  }
  const run = event.workflow_run;
  if (run?.event !== "pull_request_review" || run.name !== "Security review events") {
    return null;
  }
  // This untrusted title locates a PR only. All authority comes from fresh GitHub reads;
  // no artifacts, source, approval claims, or credentials from the signal run are used.
  const match = /^PR ([1-9][0-9]*)$/u.exec(run.display_title ?? "");
  return match ? Number(match[1]) : null;
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

export async function openGuard({ context }) {
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

export async function findMaintainerApproval(guard) {
  const { pullRequest } = guard;
  const sha = pullRequest.head.sha;
  const authorRole = await maintainerRole(guard, pullRequest.user);
  if (authorRole) {
    return { kind: "author", login: pullRequest.user.login, role: authorRole, sha };
  }
  const reviews = await guard.api.paginate(`${guard.pullPath}/reviews`);
  const latest = new Map();
  // GitHub returns reviews chronologically. Comments and pending drafts do not
  // revoke an approval; a dismissal or a subsequent verdict does.
  for (const review of reviews) {
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) {
      latest.set(review.user?.id, review);
    }
  }
  for (const review of [...latest.values()].toReversed()) {
    if (
      review.state !== "APPROVED" ||
      review.commit_id !== sha ||
      review.user?.id === pullRequest.user.id
    ) {
      continue;
    }
    const role = await maintainerRole(guard, review.user);
    if (role) {
      return { kind: "review", login: review.user.login, role, sha, url: review.html_url };
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
