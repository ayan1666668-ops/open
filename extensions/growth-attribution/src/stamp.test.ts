import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stampImage } from "./stamp.js";

describe("stampImage", () => {
  let dir: string;
  let inputPath: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "growth-stamp-"));
    inputPath = path.join(dir, "in.png");
    await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 10, g: 10, b: 10 } },
    })
      .png()
      .toFile(inputPath);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes a stamped image with overlay text and metadata", async () => {
    const outputPath = path.join(dir, "out.png");
    const result = await stampImage({
      inputPath,
      outputPath,
      growerName: "daniel",
      platform: "reddit",
      timestampMs: 1_700_000_000_000,
      label: "autumn-launch",
    });

    expect(fs.existsSync(outputPath)).toBe(true);
    expect(result.text).toContain("daniel");
    expect(result.text).toContain("reddit");
    expect(result.text).toContain("autumn-launch");

    const outMeta = await sharp(outputPath).metadata();
    expect(outMeta.width).toBe(400);
    expect(outMeta.height).toBe(300);
  });

  it("defaults timestampMs to now when omitted", async () => {
    const before = Date.now();
    const result = await stampImage({
      inputPath,
      outputPath: path.join(dir, "out2.png"),
      growerName: "priya",
      platform: "instagram",
    });
    expect(result.timestampMs).toBeGreaterThanOrEqual(before);
  });
});
