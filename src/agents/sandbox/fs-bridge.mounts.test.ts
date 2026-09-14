import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSandboxDockerConfig } from "./config.js";
import {
  createSandbox,
  createSandboxFsBridge,
  dockerExecResult,
  getDockerArg,
  getDockerScript,
  installFsBridgeTestHarness,
  mockedExecDockerRaw,
  withTempDir,
} from "./fs-bridge.test-helpers.js";
import { buildSandboxFsMounts, resolveWritableSandboxBindHostRoots } from "./fs-paths.js";

describe("sandbox effective filesystem mounts", () => {
  installFsBridgeTestHarness();

  it.each(["rw", "ro"] as const)(
    "uses the last global/agent /data bind with %s access",
    async (mode) => {
      await withTempDir("openclaw-effective-mounts-", async (workspaceDir) => {
        for (const name of ["A", "B"]) {
          await fs.mkdir(path.join(workspaceDir, name));
          await fs.writeFile(path.join(workspaceDir, name, "marker"), name);
        }
        const docker = resolveSandboxDockerConfig({
          scope: "agent",
          globalDocker: { binds: [`${workspaceDir}/A:/data:${mode === "rw" ? "ro" : "rw"}`] },
          agentDocker: { binds: [`${workspaceDir}/B:/data/:${mode}`] },
        });
        const sandbox = createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          workspaceAccess: "rw",
          docker,
        });
        const bridge = createSandboxFsBridge({ sandbox });
        expect((await bridge.readFile({ filePath: "/data/marker" })).toString()).toBe("B");
        expect(bridge.resolvePath({ filePath: "/data/marker" }).hostPath).toBe(
          path.join(workspaceDir, "B/marker"),
        );
        expect(
          buildSandboxFsMounts(sandbox).filter((mount) => mount.containerRoot === "/data"),
        ).toHaveLength(1);
        expect(resolveWritableSandboxBindHostRoots(docker.binds)).toEqual(
          mode === "rw" ? [path.join(workspaceDir, "B")] : [],
        );
        if (mode === "ro") {
          await expect(
            bridge.writeFile({ filePath: "/data/marker", data: "changed" }),
          ).rejects.toThrow("read-only");
          expect(mockedExecDockerRaw).not.toHaveBeenCalled();
        }
        expect(await fs.readFile(path.join(workspaceDir, "A/marker"), "utf8")).toBe("A");
      });
    },
  );

  it.each(["/workspace", "/workspace/sub"])(
    "remaps relative and host aliases through the %s override and guard",
    async (target) => {
      await withTempDir("openclaw-effective-mounts-", async (root) => {
        const workspaceDir = path.join(root, "workspace");
        const override = path.join(root, "override");
        await fs.mkdir(path.join(workspaceDir, "sub"), { recursive: true });
        await fs.mkdir(override);
        await fs.writeFile(path.join(override, "marker"), "VISIBLE");
        const relative = target === "/workspace" ? "marker" : "sub/marker";
        await fs.writeFile(path.join(workspaceDir, relative), "HIDDEN");
        const sandbox = createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          workspaceAccess: "rw",
          docker: { ...createSandbox().docker, binds: [`${override}:${target}:ro`] },
        });
        const bridge = createSandboxFsBridge({ sandbox });
        for (const filePath of [
          relative,
          `/workspace/${relative}`,
          path.join(workspaceDir, relative),
        ]) {
          expect((await bridge.readFile({ filePath })).toString()).toBe("VISIBLE");
          await expect(bridge.writeFile({ filePath, data: "changed" })).rejects.toThrow(
            "read-only",
          );
        }
        expect(mockedExecDockerRaw).not.toHaveBeenCalled();
      });
    },
  );

  it("refuses configured tmpfs and symlink aliases while allowing a deeper bind", async () => {
    await withTempDir("openclaw-effective-mounts-", async (workspaceDir) => {
      await fs.mkdir(path.join(workspaceDir, "cache"));
      await fs.mkdir(path.join(workspaceDir, "export"));
      await fs.writeFile(path.join(workspaceDir, "cache/marker"), "HIDDEN");
      await fs.writeFile(path.join(workspaceDir, "export/marker"), "VISIBLE");
      await fs.symlink("cache/marker", path.join(workspaceDir, "alias"));
      const sandbox = createSandbox({
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        workspaceAccess: "rw",
        docker: {
          ...createSandbox().docker,
          tmpfs: ["/workspace/cache:rw"],
          binds: [`${workspaceDir}/export:/workspace/cache/export:ro`],
        },
      });
      const bridge = createSandboxFsBridge({ sandbox });
      for (const filePath of [
        "cache/marker",
        "/workspace/cache/marker",
        path.join(workspaceDir, "cache/marker"),
        "alias",
      ]) {
        await expect(bridge.readFile({ filePath })).rejects.toThrow("container-only");
      }
      expect((await bridge.readFile({ filePath: "cache/export/marker" })).toString()).toBe(
        "VISIBLE",
      );
      expect(mockedExecDockerRaw).not.toHaveBeenCalled();
    });
  });

  it("rejects aliases into replaced host subtrees but keeps same-source skill aliases readable", async () => {
    await withTempDir("openclaw-effective-mounts-", async (workspaceDir) => {
      for (const name of ["data", "replacement", "skills", "ordinary"]) {
        await fs.mkdir(path.join(workspaceDir, name));
        await fs.writeFile(path.join(workspaceDir, name, "marker"), name);
        await fs.symlink(`${name}/marker`, path.join(workspaceDir, `${name}-alias`));
      }
      const sandbox = createSandbox({
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        workspaceAccess: "rw",
        docker: {
          ...createSandbox().docker,
          binds: [`${workspaceDir}/replacement:/workspace/data:ro`],
        },
      });
      const bridge = createSandboxFsBridge({ sandbox });
      await expect(bridge.readFile({ filePath: "data-alias" })).rejects.toThrow(
        "hidden by another mount",
      );
      expect((await bridge.readFile({ filePath: "data/marker" })).toString()).toBe("replacement");
      expect((await bridge.readFile({ filePath: "skills-alias" })).toString()).toBe("skills");
      expect((await bridge.readFile({ filePath: "ordinary-alias" })).toString()).toBe("ordinary");
      expect(mockedExecDockerRaw).not.toHaveBeenCalled();
    });
  });

  it.each(["ancestor", "same", ...(process.platform === "win32" ? [] : ["symlink", "canonical"])])(
    "keeps the default workspace alias ahead of a %s custom source",
    async (source) => {
      await withTempDir("openclaw-effective-mounts-", async (root) => {
        const actualWorkspace = path.join(root, "project/work");
        const workspaceDir =
          source === "symlink" || source === "canonical" ? path.join(root, "ws") : actualWorkspace;
        const replacement = path.join(root, "replacement");
        await fs.mkdir(actualWorkspace, { recursive: true });
        if (workspaceDir !== actualWorkspace) {
          await fs.symlink(actualWorkspace, workspaceDir, "dir");
        }
        await fs.mkdir(replacement);
        await fs.writeFile(path.join(workspaceDir, "marker"), "HIDDEN");
        await fs.writeFile(path.join(replacement, "marker"), "VISIBLE");
        const sandbox = createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          workspaceAccess: "rw",
          docker: {
            ...createSandbox().docker,
            binds: [
              ...(source === "canonical"
                ? []
                : [`${source === "ancestor" ? `${root}/project` : actualWorkspace}:/data:rw`]),
              `${replacement}:/workspace:ro`,
            ],
          },
        });
        const bridge = createSandboxFsBridge({ sandbox });
        for (const filePath of [
          "marker",
          path.join(workspaceDir, "marker"),
          "/workspace/marker",
          ...(source === "canonical" ? [path.join(actualWorkspace, "marker")] : []),
        ]) {
          expect((await bridge.readFile({ filePath })).toString()).toBe("VISIBLE");
          await expect(bridge.writeFile({ filePath, data: "changed" })).rejects.toThrow(
            "read-only",
          );
        }
        if (source !== "canonical")
          expect(
            (
              await bridge.readFile({
                filePath: source === "ancestor" ? "/data/work/marker" : "/data/marker",
              })
            ).toString(),
          ).toBe("HIDDEN");
      });
    },
  );

  it("reads a same-source overlay reached through a declared source symlink", async () => {
    await withTempDir("openclaw-effective-mounts-", async (workspaceDir) => {
      await fs.mkdir(path.join(workspaceDir, "data"));
      await fs.writeFile(path.join(workspaceDir, "data/marker"), "VISIBLE");
      await fs.symlink("data", path.join(workspaceDir, "source-alias"), "dir");
      await fs.symlink("data/marker", path.join(workspaceDir, "read-alias"));
      const sandbox = createSandbox({
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        workspaceAccess: "rw",
        docker: {
          ...createSandbox().docker,
          binds: [`${workspaceDir}/source-alias:/workspace/data:ro`],
        },
      });
      const bridge = createSandboxFsBridge({ sandbox });
      for (const filePath of ["read-alias", "data/marker"]) {
        expect((await bridge.readFile({ filePath })).toString()).toBe("VISIBLE");
      }
      expect(mockedExecDockerRaw).not.toHaveBeenCalled();
    });
  });

  it.runIf(process.platform !== "win32")(
    "preserves distinct whitespace in bind sources and destinations",
    async () => {
      await withTempDir("openclaw-effective-mounts-", async (workspaceDir) => {
        for (const name of ["A", "B "]) {
          await fs.mkdir(path.join(workspaceDir, name));
          await fs.writeFile(path.join(workspaceDir, name, "marker"), name);
        }
        const sandbox = createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          workspaceAccess: "rw",
          docker: {
            ...createSandbox().docker,
            binds: [`${workspaceDir}/A:/data:ro`, `${workspaceDir}/B :/data :rw`],
          },
        });
        const bridge = createSandboxFsBridge({ sandbox });
        expect((await bridge.readFile({ filePath: "/data/marker" })).toString()).toBe("A");
        expect((await bridge.readFile({ filePath: "/data /marker" })).toString()).toBe("B ");
        expect(bridge.resolvePath({ filePath: "/data " }).hostPath).toBe(
          path.join(workspaceDir, "B "),
        );
        expect(resolveWritableSandboxBindHostRoots(sandbox.docker.binds)).toEqual([
          path.join(workspaceDir, "B "),
        ]);
        mockedExecDockerRaw.mockImplementation(async (args) => {
          if (getDockerScript(args).includes('readlink -f -- "$cursor"')) {
            return dockerExecResult(`${getDockerArg(args, 1)}\n`);
          }
          return dockerExecResult(getDockerArg(args, 1) === "readdir" ? "[]" : "");
        });
        await bridge.writeFile({ filePath: "/data /marker", data: "updated" });
        await bridge.readDirectory!({ filePath: "/data " });
        for (const operation of ["write", "readdir"]) {
          const call = mockedExecDockerRaw.mock.calls.find(
            ([args]) => getDockerArg(args, 1) === operation,
          );
          expect(call).toBeDefined();
          expect(getDockerArg(call![0], 2)).toBe("/data ");
          expect(getDockerArg(call![0], 3)).toBe("");
        }
        await expect(
          bridge.writeFile({ filePath: "/data/marker", data: "denied" }),
        ).rejects.toThrow("read-only");
      });
    },
  );
});
