import crypto from "node:crypto";

const SLUG_RE = /[^a-z0-9_-]+/g;

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-").replace(SLUG_RE, "");
}

function computeSignature(
  secret: string,
  parts: { growerName: string; platform: string; campaign: string; timestampMs: number },
): string {
  const payload = `${parts.growerName}|${parts.platform}|${parts.campaign}|${parts.timestampMs}`;
  return crypto.createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16);
}

export type TrackingLinkInput = {
  /** Destination URL to attach tracking params to. */
  url: string;
  /** Growth team member issuing the link (e.g. "daniel"). */
  growerName: string;
  /** Destination platform (e.g. "reddit", "instagram"). */
  platform: string;
  /** Campaign label; defaults to "growth". */
  campaign?: string;
  /** utm_medium; defaults to "social". */
  medium?: string;
  /** utm_content override; defaults to growerName. */
  content?: string;
  /** Issue timestamp in ms; defaults to Date.now(). */
  timestampMs?: number;
  /** HMAC secret used to sign the grower/platform/campaign/timestamp tuple. */
  secret: string;
};

export type TrackingLinkResult = {
  id: string;
  url: string;
  growerName: string;
  platform: string;
  campaign: string;
  medium: string;
  content: string;
  timestampMs: number;
  sig: string;
};

export function buildTrackingLink(input: TrackingLinkInput): TrackingLinkResult {
  if (!input.secret) {
    throw new Error("buildTrackingLink: secret is required");
  }
  const growerName = slugify(input.growerName);
  const platform = slugify(input.platform);
  if (!growerName) throw new Error("buildTrackingLink: growerName is required");
  if (!platform) throw new Error("buildTrackingLink: platform is required");

  const campaign = slugify(input.campaign ?? "growth") || "growth";
  const medium = input.medium?.trim() || "social";
  const content = input.content?.trim() || growerName;
  const timestampMs = input.timestampMs ?? Date.now();

  const sig = computeSignature(input.secret, { growerName, platform, campaign, timestampMs });

  const url = new URL(input.url);
  url.searchParams.set("utm_source", platform);
  url.searchParams.set("utm_medium", medium);
  url.searchParams.set("utm_campaign", campaign);
  url.searchParams.set("utm_content", content);
  url.searchParams.set("kora_by", growerName);
  url.searchParams.set("kora_ts", String(timestampMs));
  url.searchParams.set("kora_sig", sig);

  return {
    id: sig.slice(0, 10),
    url: url.toString(),
    growerName,
    platform,
    campaign,
    medium,
    content,
    timestampMs,
    sig,
  };
}

export type TrackingLinkVerification = {
  valid: boolean;
  growerName?: string;
  platform?: string;
  campaign?: string;
  timestampMs?: number;
  reason?: string;
};

export function verifyTrackingLink(urlStr: string, secret: string): TrackingLinkVerification {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return { valid: false, reason: "invalid_url" };
  }

  const growerName = url.searchParams.get("kora_by");
  const platform = url.searchParams.get("utm_source");
  const campaign = url.searchParams.get("utm_campaign");
  const tsRaw = url.searchParams.get("kora_ts");
  const sig = url.searchParams.get("kora_sig");

  if (!growerName || !platform || !campaign || !tsRaw || !sig) {
    return { valid: false, reason: "missing_fields" };
  }

  const timestampMs = Number(tsRaw);
  if (!Number.isFinite(timestampMs)) {
    return { valid: false, reason: "invalid_timestamp" };
  }

  const expected = computeSignature(secret, { growerName, platform, campaign, timestampMs });
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(sig);
  const matches =
    expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);

  if (!matches) {
    return { valid: false, reason: "signature_mismatch" };
  }

  return { valid: true, growerName, platform, campaign, timestampMs };
}
