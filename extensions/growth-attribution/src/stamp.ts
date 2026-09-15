import path from "node:path";
import sharp from "sharp";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTimestamp(timestampMs: number): string {
  return new Date(timestampMs)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC");
}

export type StampImageInput = {
  inputPath: string;
  outputPath: string;
  growerName: string;
  platform: string;
  timestampMs?: number;
  /** Extra label appended to the stamp, e.g. campaign name. */
  label?: string;
};

export type StampImageResult = {
  outputPath: string;
  growerName: string;
  platform: string;
  timestampMs: number;
  text: string;
};

/** Overlays a name/platform/timestamp watermark in the bottom-right corner. */
export async function stampImage(input: StampImageInput): Promise<StampImageResult> {
  const timestampMs = input.timestampMs ?? Date.now();
  const line1 = `${input.growerName} · ${input.platform}${input.label ? ` · ${input.label}` : ""}`;
  const line2 = formatTimestamp(timestampMs);

  const image = sharp(input.inputPath);
  const metadata = await image.metadata();
  const width = metadata.width ?? 1080;
  const height = metadata.height ?? 1080;

  const fontSize = Math.max(14, Math.round(width * 0.018));
  const padding = Math.round(fontSize * 0.8);
  const lineHeight = Math.round(fontSize * 1.4);
  const boxWidth = Math.round(width * 0.42);
  const boxHeight = lineHeight * 2 + padding * 2;
  const boxX = width - boxWidth - padding;
  const boxY = height - boxHeight - padding;

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="${boxX}" y="${boxY}" width="${boxWidth}" height="${boxHeight}"
            rx="8" fill="black" fill-opacity="0.55" />
      <text x="${boxX + padding}" y="${boxY + padding + fontSize}"
            font-family="sans-serif" font-size="${fontSize}" font-weight="600" fill="white">${escapeXml(line1)}</text>
      <text x="${boxX + padding}" y="${boxY + padding + fontSize + lineHeight}"
            font-family="sans-serif" font-size="${Math.round(fontSize * 0.85)}" fill="white" fill-opacity="0.85">${escapeXml(line2)}</text>
    </svg>
  `;

  await sharp(input.inputPath)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .toFile(input.outputPath);

  return {
    outputPath: path.resolve(input.outputPath),
    growerName: input.growerName,
    platform: input.platform,
    timestampMs,
    text: `${line1} / ${line2}`,
  };
}
