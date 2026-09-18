import path from "node:path";

export function isHomebrewInstallRoot(pkgRoot: string): boolean {
  const normalized = path.resolve(pkgRoot);
  return /[/\\](?:Cellar|opt)[/\\]openclaw-cli[/\\]/i.test(normalized);
}
