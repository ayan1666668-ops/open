import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listRegisteredAgentHarnesses,
  registerAgentHarness,
} from "../../agents/harness/registry.js";
import { restoreRegisteredAgentHarnesses } from "../../agents/harness/registry.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  resolveSessionPlacementDisabledReason,
  SESSION_PLACEMENT_PREPARED_AUTH_REASON,
  SESSION_PLACEMENT_WORKSPACE_SYMLINKS_REASON,
} from "./device-placement-eligibility.js";
import {
  resolveMissingPreparedAuthForPlacement,
  resolveSessionPlacementPreflight,
  workspaceHasEscapingSymlinks,
} from "./session-placement-preflight.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
});

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function git(cwd: string, ...args: string[]) {
  const result = await runCommandWithTimeout(["git", "-C", cwd, ...args], { timeoutMs: 10_000 });
  expect(result.code, result.stderr).toBe(0);
}

async function initGitRepo(cwd: string) {
  await git(cwd, "init", "--quiet");
  await git(cwd, "config", "user.name", "Session Preflight Test");
  await git(cwd, "config", "user.email", "session-preflight@example.invalid");
}

function registerRemoteCodex() {
  const registered = listRegisteredAgentHarnesses();
  registerAgentHarness({
    id: "codex-remote",
    label: "Codex remote",
    autoSelection: { providerIds: ["openai"] },
    supports: () => ({ supported: true }),
    cloudPlacement: {
      mode: "remote-exec",
      devicePlacement: {
        requiredNodeCommands: ["codex.exec-server.stdio.v1"],
        consumesWorkerSlot: false,
      },
    },
    runAttempt: async () => {
      throw new Error("preflight must not execute");
    },
  });
  return registered;
}

describe("session-host placement preflight", () => {
  it("detects escaping workspace symlinks for environments.list projection", async () => {
    const root = await makeTempRoot("openclaw-session-preflight-symlink-");
    const outside = await makeTempRoot("openclaw-session-preflight-outside-");
    await fs.symlink(outside, path.join(root, "escape"));
    await expect(workspaceHasEscapingSymlinks(root)).resolves.toBe(true);
    const preflight = await resolveSessionPlacementPreflight({
      config: {} as OpenClawConfig,
      workspacePath: root,
    });
    expect(preflight.workspaceHasEscapingSymlinks).toBe(true);
    expect(resolveSessionPlacementDisabledReason(preflight)).toBe(
      SESSION_PLACEMENT_WORKSPACE_SYMLINKS_REASON,
    );
  });

  it("ignores escaping symlinks under derived paths such as node_modules", async () => {
    const root = await makeTempRoot("openclaw-session-preflight-derived-");
    const outside = await makeTempRoot("openclaw-session-preflight-outside-");
    await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await fs.symlink(outside, path.join(root, "node_modules", "pkg", "escape"));
    await expect(workspaceHasEscapingSymlinks(root)).resolves.toBe(false);
  });

  it("ignores escaping symlinks that Git would not transfer", async () => {
    const root = await makeTempRoot("openclaw-session-preflight-ignored-");
    const outside = await makeTempRoot("openclaw-session-preflight-outside-");
    await initGitRepo(root);
    await fs.writeFile(path.join(root, ".gitignore"), "ignored/\n");
    await fs.mkdir(path.join(root, "ignored"), { recursive: true });
    await fs.symlink(outside, path.join(root, "ignored", "escape"));
    await fs.writeFile(path.join(root, "tracked.txt"), "ok\n");
    await git(root, "add", ".gitignore", "tracked.txt");
    await git(root, "commit", "--quiet", "-m", "init");
    await expect(workspaceHasEscapingSymlinks(root)).resolves.toBe(false);
  });

  it("still flags transfer-eligible escaping symlinks in a Git workspace", async () => {
    const root = await makeTempRoot("openclaw-session-preflight-eligible-");
    const outside = await makeTempRoot("openclaw-session-preflight-outside-");
    await initGitRepo(root);
    await fs.symlink(outside, path.join(root, "escape"));
    await fs.writeFile(path.join(root, "tracked.txt"), "ok\n");
    await git(root, "add", "tracked.txt");
    await git(root, "commit", "--quiet", "-m", "init");
    await expect(workspaceHasEscapingSymlinks(root)).resolves.toBe(true);
  });

  it("does not apply Git exclusions for unborn repositories (plain transfer mode)", async () => {
    const root = await makeTempRoot("openclaw-session-preflight-unborn-");
    const outside = await makeTempRoot("openclaw-session-preflight-outside-");
    await initGitRepo(root);
    await fs.writeFile(path.join(root, ".gitignore"), "ignored/\n");
    await fs.mkdir(path.join(root, "ignored"), { recursive: true });
    await fs.symlink(outside, path.join(root, "ignored", "escape"));
    // No commit => probeWorkspaceGitMode treats this as plain; check-ignore must not skip.
    await expect(workspaceHasEscapingSymlinks(root)).resolves.toBe(true);
  });

  it("marks missing prepared auth for remote-exec when homeScope is user", () => {
    const registered = registerRemoteCodex();
    try {
      const config = {
        plugins: { entries: { codex: { config: { appServer: { homeScope: "user" } } } } },
      } as OpenClawConfig;
      expect(resolveMissingPreparedAuthForPlacement({ config, runtimeId: "codex-remote" })).toBe(
        true,
      );
      expect(resolveSessionPlacementDisabledReason({ missingPreparedAuth: true })).toBe(
        SESSION_PLACEMENT_PREPARED_AUTH_REASON,
      );
    } finally {
      restoreRegisteredAgentHarnesses(registered);
    }
  });

  it("uses the selected agent config profiles instead of only ambient default", () => {
    const registered = registerRemoteCodex();
    try {
      const config = {
        agents: {
          list: [{ id: "main", default: true }, { id: "research" }],
        },
        auth: {
          profiles: {
            "openai:research": { provider: "openai", mode: "api_key" },
          },
        },
        plugins: { entries: { codex: { config: { appServer: { homeScope: "agent" } } } } },
      } as OpenClawConfig;
      // Without agentId, ambient owner may still see global config profiles.
      // With an explicit non-matching profile id, route must stay blocked.
      expect(
        resolveMissingPreparedAuthForPlacement({
          config,
          runtimeId: "codex-remote",
          agentId: "research",
          authProfileId: "anthropic:research",
        }),
      ).toBe(true);
      expect(
        resolveMissingPreparedAuthForPlacement({
          config,
          runtimeId: "codex-remote",
          agentId: "research",
          authProfileId: "openai:research",
        }),
      ).toBe(false);
    } finally {
      restoreRegisteredAgentHarnesses(registered);
    }
  });

  it("preserves prepared API-key routes when the profile snapshot is empty", () => {
    const registered = registerRemoteCodex();
    try {
      const config = {
        models: {
          providers: {
            openai: { apiKey: "sk-prepared-platform-key", baseUrl: "", models: [] },
          },
        },
        plugins: { entries: { codex: { config: { appServer: { homeScope: "agent" } } } } },
      } as OpenClawConfig;
      expect(
        resolveMissingPreparedAuthForPlacement({
          config,
          runtimeId: "codex-remote",
          agentId: "research",
        }),
      ).toBe(false);
    } finally {
      restoreRegisteredAgentHarnesses(registered);
    }
  });

  it("still blocks when a requested auth profile is missing even if models.providers has a key", () => {
    const registered = registerRemoteCodex();
    try {
      const config = {
        models: {
          providers: {
            openai: { apiKey: "sk-prepared-platform-key", baseUrl: "", models: [] },
          },
        },
        plugins: { entries: { codex: { config: { appServer: { homeScope: "agent" } } } } },
      } as OpenClawConfig;
      expect(
        resolveMissingPreparedAuthForPlacement({
          config,
          runtimeId: "codex-remote",
          agentId: "research",
          authProfileId: "openai:missing-pin",
        }),
      ).toBe(true);
    } finally {
      restoreRegisteredAgentHarnesses(registered);
    }
  });

  it("stacks symlink and prepared-auth disabledReason for list/preflight projection", async () => {
    const reason = resolveSessionPlacementDisabledReason({
      workspaceHasEscapingSymlinks: true,
      missingPreparedAuth: true,
    });
    expect(reason).toContain(SESSION_PLACEMENT_WORKSPACE_SYMLINKS_REASON);
    expect(reason).toContain(SESSION_PLACEMENT_PREPARED_AUTH_REASON);
  });
});
