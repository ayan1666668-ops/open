import fs from "node:fs";
import path from "node:path";

export type LedgerEntry = {
  id: string;
  kind: "link" | "image";
  growerName: string;
  platform: string;
  campaign: string;
  timestampMs: number;
  sig: string;
  /** Final tracking URL, present for kind "link". */
  url?: string;
  /** Output image path, present for kind "image". */
  imagePath?: string;
  note?: string;
};

export function appendLedgerEntry(ledgerPath: string, entry: LedgerEntry): void {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, "utf8");
}

export type LedgerFilter = {
  growerName?: string;
  platform?: string;
  sinceMs?: number;
};

export function readLedgerEntries(ledgerPath: string, filter: LedgerFilter = {}): LedgerEntry[] {
  if (!fs.existsSync(ledgerPath)) {
    return [];
  }
  const lines = fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
  const entries: LedgerEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as LedgerEntry);
    } catch {
      // Skip corrupt lines rather than fail the whole read.
    }
  }
  return entries.filter((entry) => {
    if (filter.growerName && entry.growerName !== filter.growerName) return false;
    if (filter.platform && entry.platform !== filter.platform) return false;
    if (filter.sinceMs && entry.timestampMs < filter.sinceMs) return false;
    return true;
  });
}

export function defaultLedgerPath(): string {
  const base = process.env.GROWTH_ATTRIBUTION_STATE_DIR ?? path.join(process.cwd(), ".openclaw");
  return path.join(base, "growth-attribution", "ledger.jsonl");
}
