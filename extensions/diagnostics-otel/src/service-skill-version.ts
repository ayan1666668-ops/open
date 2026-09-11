import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

const MAX_SKILL_HASH_DEPTH = 6;

function collectSkillFiles(directory: string, depth = MAX_SKILL_HASH_DEPTH): string[] {
  if (depth < 0) {
    return [];
  }
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    const filePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSkillFiles(filePath, depth - 1));
    } else if (entry.isFile()) {
      files.push(filePath);
    }
  }
  return files;
}

export function computeOtelSkillVersion(skillFile: string): string | undefined {
  const root = basename(skillFile) === "SKILL.md" ? dirname(skillFile) : undefined;
  const files = (root ? collectSkillFiles(root) : [skillFile]).toSorted((left, right) =>
    left.localeCompare(right),
  );
  const hash = createHash("sha256");
  let hashed = false;
  for (const filePath of files) {
    try {
      const identity = root ? relative(root, filePath).split(sep).join("/") : basename(filePath);
      hash.update(identity);
      hash.update("\0");
      hash.update(readFileSync(filePath));
      hash.update("\0");
      hashed = true;
    } catch {
      continue;
    }
  }
  return hashed ? `sha256:${hash.digest("hex").slice(0, 16)}` : undefined;
}
