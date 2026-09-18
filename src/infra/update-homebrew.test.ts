import path from "node:path";
import { describe, expect, it } from "vitest";
import { isHomebrewInstallRoot } from "./update-homebrew.js";

describe("update homebrew helpers", () => {
  it("detects homebrew when package root is in Homebrew Cellar or opt prefix", () => {
    const cellarPath = path.resolve(
      "/opt/homebrew/Cellar/openclaw-cli/2026.9.2/libexec/lib/node_modules/openclaw",
    );
    const optPath = path.resolve(
      "/opt/homebrew/opt/openclaw-cli/libexec/lib/node_modules/openclaw",
    );
    const npmGlobalPath = path.resolve("/opt/homebrew/lib/node_modules/openclaw");

    expect(isHomebrewInstallRoot(cellarPath)).toBe(true);
    expect(isHomebrewInstallRoot(optPath)).toBe(true);
    expect(isHomebrewInstallRoot(npmGlobalPath)).toBe(false);
    expect(isHomebrewInstallRoot("/usr/local/lib/node_modules/openclaw")).toBe(false);
  });
});
