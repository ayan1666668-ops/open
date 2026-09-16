import path from "node:path";
import { describe, expect, it } from "vitest";
import { type IncludeResolver, resolveConfigIncludesForTopLevelKey } from "./includes.js";

const CONFIG_DIR = path.join(path.parse(process.cwd()).root, "config");
const DEFAULT_BASE_PATH = path.join(CONFIG_DIR, "openclaw.json");

function configPath(name: string): string {
  return path.join(CONFIG_DIR, name);
}

function createMockResolver(files: Record<string, unknown>): IncludeResolver {
  return {
    readFile: (filePath) => {
      if (filePath in files) {
        return JSON.stringify(files[filePath]);
      }
      throw new Error(`ENOENT: no such file: ${filePath}`);
    },
    parseJson: JSON.parse,
  };
}

describe("resolveConfigIncludesForTopLevelKey", () => {
  it("projects through root includes without resolving malformed siblings", () => {
    const files = {
      [configPath("defaults.json")]: {
        logging: { consoleStyle: "pretty", level: "debug" },
        plugins: { $include: "./missing-plugins.json" },
      },
      [configPath("override.json")]: {
        logging: { consoleStyle: "json" },
      },
    };

    expect(
      resolveConfigIncludesForTopLevelKey(
        {
          $include: ["./defaults.json", "./override.json"],
          logging: { level: "info" },
          agents: { $include: "./missing-agents.json" },
        },
        DEFAULT_BASE_PATH,
        "logging",
        createMockResolver(files),
      ),
    ).toEqual({ logging: { consoleStyle: "json", level: "info" } });
  });

  it("projects a deeply nested top-level key without walking it recursively", () => {
    // The projection is how the pre-runtime logging reader selects its block, so
    // a deep block must not exhaust the stack before the reader can use it.
    const depth = 20_000;
    let deep: unknown = "json";
    for (let index = 0; index < depth; index += 1) {
      deep = { consoleStyle: deep };
    }

    const projected = resolveConfigIncludesForTopLevelKey(
      { logging: deep, agents: { defaults: { params: { retained: true } } } },
      DEFAULT_BASE_PATH,
      "logging",
      createMockResolver({}),
    ) as { logging: unknown };

    let cursor = projected.logging;
    for (let index = 0; index < depth; index += 1) {
      cursor = (cursor as { consoleStyle: unknown }).consoleStyle;
    }
    expect(cursor).toBe("json");
  });
});
