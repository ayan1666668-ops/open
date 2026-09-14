import path from "node:path";
import { vi } from "vitest";
import type { ApplyPatchSummary } from "./apply-patch.js";
import "./apply-patch.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

type ApplyPatchOptions = {
  cwd: string;
  sandbox?: { root: string; bridge: SandboxFsBridge };
  workspaceOnly?: boolean;
  signal?: AbortSignal;
};

type ApplyPatchResult = {
  summary: ApplyPatchSummary;
  text: string;
  noOp?: boolean;
};

type ApplyPatchTestApi = {
  applyPatch(input: string, options: ApplyPatchOptions): Promise<ApplyPatchResult>;
};

function getTestApi(): ApplyPatchTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.applyPatchTestApi")
  ];
  if (!api) {
    throw new Error("apply patch test API is unavailable");
  }
  return api as ApplyPatchTestApi;
}

export async function applyPatch(
  input: string,
  options: ApplyPatchOptions,
): Promise<ApplyPatchResult> {
  return await getTestApi().applyPatch(input, options);
}

export function createMemoryPatchSandbox(
  initialFiles: Record<string, string | Buffer> = {},
  options: { supportsExclusiveCreate?: boolean } = {},
) {
  const resolvePath = (filePath: string) => path.posix.resolve("/sandbox", filePath);
  const files = new Map<string, string | Buffer>(
    Object.entries(initialFiles).map(([filePath, contents]) => [resolvePath(filePath), contents]),
  );
  const writeFile = vi.fn(async ({ filePath, data }) => {
    files.set(resolvePath(filePath), Buffer.isBuffer(data) ? Buffer.from(data) : data);
  });
  const createFileExclusive = vi.fn(async ({ filePath, data }) => {
    const target = resolvePath(filePath);
    if (files.has(target)) {
      return "exists" as const;
    }
    files.set(target, Buffer.isBuffer(data) ? Buffer.from(data) : data);
    return "created" as const;
  });
  const remove = vi.fn(async ({ filePath }) => {
    files.delete(resolvePath(filePath));
  });
  const mkdirp = vi.fn(async () => {});
  const bridge: SandboxFsBridge = {
    resolvePath: ({ filePath }) => ({
      relativePath: path.posix.relative("/sandbox", resolvePath(filePath)),
      containerPath: resolvePath(filePath),
    }),
    readFile: async ({ filePath }) => {
      const contents = files.get(resolvePath(filePath));
      return typeof contents === "string"
        ? Buffer.from(contents, "utf8")
        : Buffer.from(contents ?? "");
    },
    writeFile,
    ...(options.supportsExclusiveCreate === false ? {} : { createFileExclusive }),
    remove,
    rename: async ({ from, to }) => {
      const source = resolvePath(from);
      const target = resolvePath(to);
      const contents = files.get(source);
      if (contents !== undefined) {
        files.set(target, contents);
        if (source !== target) {
          files.delete(source);
        }
      }
    },
    stat: async ({ filePath }) => {
      const contents = files.get(resolvePath(filePath));
      return contents === undefined
        ? null
        : { type: "file", size: Buffer.byteLength(contents), mtimeMs: 0 };
    },
    mkdirp,
  };
  return {
    files,
    bridge,
    writeFile,
    createFileExclusive,
    remove,
    mkdirp,
    options: {
      cwd: "/local/workspace",
      sandbox: {
        root: "/local/workspace",
        bridge,
      },
    },
  };
}
