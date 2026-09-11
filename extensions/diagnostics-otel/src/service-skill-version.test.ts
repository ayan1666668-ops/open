import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeOtelSkillVersion } from "./service-skill-version.js";

describe("skill telemetry content version", () => {
  it("changes when instructions or support files change", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-otel-skill-"));
    try {
      const skillFile = join(root, "SKILL.md");
      writeFileSync(skillFile, "# Example\n");
      const initial = computeOtelSkillVersion(skillFile);

      mkdirSync(join(root, "references"));
      writeFileSync(join(root, "references", "guide.md"), "first\n");
      const withSupportFile = computeOtelSkillVersion(skillFile);
      writeFileSync(join(root, "references", "guide.md"), "second\n");

      expect(initial).toMatch(/^sha256:[a-f0-9]{16}$/);
      expect(withSupportFile).not.toBe(initial);
      expect(computeOtelSkillVersion(skillFile)).not.toBe(withSupportFile);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
