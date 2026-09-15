import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendLedgerEntry, readLedgerEntries } from "./ledger.js";

describe("ledger", () => {
  let dir: string;
  let ledgerPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "growth-ledger-"));
    ledgerPath = path.join(dir, "nested", "ledger.jsonl");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("appends and reads entries, creating parent dirs", () => {
    appendLedgerEntry(ledgerPath, {
      id: "a1",
      kind: "link",
      growerName: "daniel",
      platform: "reddit",
      campaign: "growth",
      timestampMs: 1000,
      sig: "sig1",
      url: "https://x.com?a=1",
    });
    appendLedgerEntry(ledgerPath, {
      id: "a2",
      kind: "image",
      growerName: "priya",
      platform: "instagram",
      campaign: "growth",
      timestampMs: 2000,
      sig: "",
      imagePath: "/tmp/out.png",
    });

    const all = readLedgerEntries(ledgerPath);
    expect(all).toHaveLength(2);
    expect(all[0].id).toBe("a1");
    expect(all[1].id).toBe("a2");
  });

  it("filters by grower, platform, and since", () => {
    appendLedgerEntry(ledgerPath, {
      id: "a1",
      kind: "link",
      growerName: "daniel",
      platform: "reddit",
      campaign: "growth",
      timestampMs: 1000,
      sig: "sig1",
    });
    appendLedgerEntry(ledgerPath, {
      id: "a2",
      kind: "link",
      growerName: "priya",
      platform: "reddit",
      campaign: "growth",
      timestampMs: 5000,
      sig: "sig2",
    });

    expect(readLedgerEntries(ledgerPath, { growerName: "daniel" })).toHaveLength(1);
    expect(readLedgerEntries(ledgerPath, { platform: "reddit" })).toHaveLength(2);
    expect(readLedgerEntries(ledgerPath, { sinceMs: 4000 })).toHaveLength(1);
  });

  it("returns an empty array when the ledger does not exist", () => {
    expect(readLedgerEntries(path.join(dir, "missing.jsonl"))).toEqual([]);
  });

  it("skips corrupt lines", () => {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, 'not json\n{"id":"ok","kind":"link"}\n');
    const entries = readLedgerEntries(ledgerPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("ok");
  });
});
