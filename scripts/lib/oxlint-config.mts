import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import type { OxlintConfig } from "oxlint";

export type OxlintJsonConfig = Omit<OxlintConfig, "extends"> & {
  $schema?: string;
  extends?: string[];
};

export function readOxlintConfig(root: string, configPath = ".oxlintrc.json"): OxlintJsonConfig {
  return JSON5.parse<OxlintJsonConfig>(fs.readFileSync(path.resolve(root, configPath), "utf8"));
}
