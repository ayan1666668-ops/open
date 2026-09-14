import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCoreCodingTools } from "./core-coding-tools.js";
import { createMemoryWriteProvenanceObserver } from "./memory-write-provenance.js";
import { resolveSandboxFileIdentity } from "./sandbox/file-mutation-identity.js";
import {
  createSandbox,
  createSandboxFsBridge,
  installFsBridgeTestHarness,
  withTempDir,
} from "./sandbox/fs-bridge.test-helpers.js";
import { getTextContent } from "./test-helpers/agent-tools-fs-helpers.js";

describe("workspace-only coding tools with effective sandbox mounts", () => {
  installFsBridgeTestHarness();

  it("guards the visible workspace while preserving read-only exceptions for additional mounts", async () => {
    await withTempDir("openclaw-coding-mounts-", async (root) => {
      const workspaceDir = path.join(root, "workspace");
      const replacement = path.join(root, "replacement");
      const outside = path.join(root, "outside");
      const data = path.join(root, "data");
      for (const dir of [workspaceDir, replacement, outside, data]) {
        await fs.mkdir(dir);
      }
      await fs.mkdir(path.join(replacement, "sub"));
      await fs.mkdir(path.join(replacement, "cache"));
      await fs.writeFile(path.join(replacement, "sub/marker"), "VISIBLE");
      await fs.writeFile(path.join(outside, "marker"), "HIDDEN");
      await fs.writeFile(path.join(data, "marker"), "EXTRA");
      await fs.symlink(
        outside,
        path.join(workspaceDir, "sub"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await fs.symlink(
        outside,
        path.join(replacement, "escape"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const sandbox = createSandbox({
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        workspaceAccess: "rw",
        docker: {
          ...createSandbox().docker,
          binds: [
            `${replacement}:/workspace:rw`,
            `${data}:/data:rw`,
            ...(process.platform === "win32" ? [] : [`${data}:${workspaceDir}:rw`]),
          ],
          tmpfs: ["/workspace/cache"],
        },
      });
      const bridge = createSandboxFsBridge({ sandbox });
      sandbox.fsBridge = bridge;
      // Exercise factory admission with the real resolver, host guard and reader.
      // Transport mutations/listing are observed here; the Docker suite executes them.
      const write = vi.spyOn(bridge, "writeFile").mockResolvedValue();
      vi.spyOn(bridge, "mkdirp").mockResolvedValue();
      const list = vi
        .spyOn(bridge, "readDirectory")
        .mockResolvedValue([{ name: "marker", isDirectory: false }]);
      const tools = createCoreCodingTools({
        codingRoot: workspaceDir,
        containmentRoot: workspaceDir,
        includeBaseCodingTools: true,
        includeShellTools: false,
        workspaceOnly: true,
        readOnly: false,
        sandbox,
        applyPatchEnabled: false,
        applyPatchWorkspaceOnly: true,
        execDefaults: {},
        processDefaults: {},
      });
      const tool = (name: string) => {
        const found = tools.find((entry) => entry.name === name);
        if (!found) {
          throw new Error(`Missing ${name} tool`);
        }
        return found;
      };
      for (const filePath of [
        "sub/marker",
        "/workspace/sub/marker",
        "file:///workspace/sub/marker",
      ]) {
        expect(
          getTextContent(await tool("read").execute("read-visible", { path: filePath })),
        ).toContain("VISIBLE");
      }
      for (const filePath of ["sub/marker", "/workspace/sub/marker"]) {
        await tool("write").execute("write-visible", { path: filePath, content: "changed" });
        await tool("edit").execute("edit-visible", {
          path: filePath,
          edits: [{ oldText: "VISIBLE", newText: "edited" }],
        });
      }
      expect(write).toHaveBeenCalledTimes(4);
      for (const [request] of write.mock.calls) {
        expect(bridge.resolvePath(request).hostPath).toBe(path.join(replacement, "sub/marker"));
      }
      for (const filePath of ["sub", "/workspace/sub"]) {
        expect(
          getTextContent(await tool("ls").execute("list-visible", { path: filePath })),
        ).toContain("marker");
      }
      expect(list).toHaveBeenCalledTimes(2);
      for (const containerRoot of [
        "/data",
        ...(process.platform === "win32" ? [] : [workspaceDir]),
      ]) {
        expect(
          getTextContent(
            await tool("read").execute("read-extra", { path: `${containerRoot}/marker` }),
          ),
        ).toContain("EXTRA");
        for (const [name, args] of [
          ["write", { path: `${containerRoot}/marker`, content: "denied" }],
          [
            "edit",
            { path: `${containerRoot}/marker`, edits: [{ oldText: "EXTRA", newText: "denied" }] },
          ],
          ["ls", { path: containerRoot }],
        ] as const) {
          await expect(tool(name).execute("outside-workspace", args)).rejects.toThrow(
            "Path escapes sandbox root",
          );
        }
      }
      for (const name of ["read", "write", "ls"]) {
        await expect(
          tool(name).execute("masked", { path: "/workspace/cache/marker", content: "denied" }),
        ).rejects.toThrow("container-only");
      }
      await expect(
        tool("read").execute("visible-escape", { path: "escape/marker" }),
      ).rejects.toThrow();
      expect(write).toHaveBeenCalledTimes(4);
      expect(list).toHaveBeenCalledTimes(2);
      expect(await fs.readFile(path.join(outside, "marker"), "utf8")).toBe("HIDDEN");
      expect(await fs.readFile(path.join(data, "marker"), "utf8")).toBe("EXTRA");
    });
  });

  it("prepares patch-only workspace admission and preserves the admitted container alias", async () => {
    await withTempDir("openclaw-patch-mounts-", async (root) => {
      const workspaceDir = path.join(root, "workspace");
      const replacement = path.join(root, "replacement");
      const nested = path.join(root, "nested");
      const outside = path.join(root, "outside");
      for (const dir of [workspaceDir, replacement, nested, outside]) {
        await fs.mkdir(dir);
      }
      await fs.mkdir(path.join(replacement, "sub"));
      await fs.writeFile(path.join(replacement, "sub/marker"), "VISIBLE\n");
      await fs.writeFile(path.join(nested, "marker"), "NESTED\n");
      await fs.writeFile(path.join(outside, "marker"), "HIDDEN\n");
      await fs.symlink(
        outside,
        path.join(workspaceDir, "sub"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const sandbox = createSandbox({
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        workspaceAccess: "rw",
        docker: {
          ...createSandbox().docker,
          binds: [
            `${replacement}:/workspace:rw`,
            `${nested}:/data:ro`,
            `${nested}:/workspace/nested:rw`,
            `${outside}:/extra:rw`,
          ],
        },
      });
      const bridge = createSandboxFsBridge({ sandbox });
      sandbox.fsBridge = bridge;
      const write = vi.spyOn(bridge, "writeFile").mockResolvedValue();
      const create = vi.spyOn(bridge, "createFileExclusive").mockResolvedValue("created");
      const remove = vi.spyOn(bridge, "remove").mockResolvedValue();
      vi.spyOn(bridge, "mkdirp").mockResolvedValue();
      const patchTool = (workspaceOnly: boolean) => {
        const tool = createCoreCodingTools({
          codingRoot: workspaceDir,
          containmentRoot: workspaceDir,
          includeBaseCodingTools: false,
          includeShellTools: true,
          workspaceOnly: false,
          readOnly: false,
          sandbox,
          applyPatchEnabled: true,
          applyPatchWorkspaceOnly: workspaceOnly,
          execDefaults: {},
          processDefaults: {},
        }).find((tool) => tool.name === "apply_patch");
        if (!tool) {
          throw new Error("Missing apply_patch tool");
        }
        return tool;
      };
      const patch = patchTool(true);
      for (const filePath of ["sub/marker", "/workspace/sub/marker", "nested/marker"]) {
        await patch.execute("patch-visible", {
          input: [
            "*** Begin Patch",
            `*** Update File: ${filePath}`,
            "@@",
            filePath.startsWith("nested") ? "-NESTED" : "-VISIBLE",
            "+changed",
            "*** End Patch",
          ].join("\n"),
        });
      }
      expect(write.mock.calls.map(([request]) => request.filePath)).toEqual([
        "/workspace/sub/marker",
        "/workspace/sub/marker",
        "/workspace/nested/marker",
      ]);
      const add = (filePath: string) =>
        ["*** Begin Patch", `*** Add File: ${filePath}`, "+new", "*** End Patch"].join("\n");
      await patch.execute("patch-add", { input: add("sub/new") });
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: "/workspace/sub/new" }),
      );
      await expect(patch.execute("patch-outside", { input: add("/data/new") })).rejects.toThrow(
        "Path escapes sandbox root",
      );
      await expect(patch.execute("patch-outside", { input: add("/extra/new") })).rejects.toThrow(
        "Path escapes sandbox root",
      );
      await patchTool(false).execute("patch-opt-out", { input: add("/extra/new") });
      expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ filePath: "/extra/new" }));
      if (process.platform !== "win32") {
        await fs.symlink(path.join(outside, "marker"), path.join(replacement, "delete-link"));
        await patch.execute("patch-unlink", {
          input: "*** Begin Patch\n*** Delete File: delete-link\n*** End Patch",
        });
        expect(remove).toHaveBeenCalledWith(
          expect.objectContaining({ filePath: "/workspace/delete-link" }),
        );
      }
      const observer = createMemoryWriteProvenanceObserver({
        mutationRoot: workspaceDir,
        workspaceDir,
        resolvePath: (filePath) =>
          resolveSandboxFileIdentity({ bridge, filePath, cwd: workspaceDir }),
        resolveOriginClass: () => "agent",
      });
      expect(await observer.classifies("/workspace/memory/2026-09-14.md")).toBe(true);
      expect(await observer.classifies("/data/memory/2026-09-14.md")).toBe(false);
      expect(await fs.readFile(path.join(outside, "marker"), "utf8")).toBe("HIDDEN\n");
    });
  });
});
