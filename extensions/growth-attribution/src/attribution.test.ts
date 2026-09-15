import { describe, expect, it } from "vitest";
import { buildTrackingLink, verifyTrackingLink } from "./attribution.js";

const SECRET = "test-secret";

describe("buildTrackingLink", () => {
  it("attaches utm + kora tracking params", () => {
    const result = buildTrackingLink({
      url: "https://koracn.com/guides/shanghai",
      growerName: "Daniel",
      platform: "Reddit",
      secret: SECRET,
      timestampMs: 1_700_000_000_000,
    });

    const url = new URL(result.url);
    expect(url.searchParams.get("utm_source")).toBe("reddit");
    expect(url.searchParams.get("utm_medium")).toBe("social");
    expect(url.searchParams.get("utm_campaign")).toBe("growth");
    expect(url.searchParams.get("utm_content")).toBe("daniel");
    expect(url.searchParams.get("kora_by")).toBe("daniel");
    expect(url.searchParams.get("kora_ts")).toBe("1700000000000");
    expect(url.searchParams.get("kora_sig")).toBe(result.sig);
    expect(result.id).toHaveLength(10);
  });

  it("rejects missing name/platform", () => {
    expect(() =>
      buildTrackingLink({
        url: "https://x.com",
        growerName: "",
        platform: "reddit",
        secret: SECRET,
      }),
    ).toThrow();
    expect(() =>
      buildTrackingLink({
        url: "https://x.com",
        growerName: "daniel",
        platform: "",
        secret: SECRET,
      }),
    ).toThrow();
  });

  it("requires a secret", () => {
    expect(() =>
      buildTrackingLink({
        url: "https://x.com",
        growerName: "daniel",
        platform: "reddit",
        secret: "",
      }),
    ).toThrow();
  });
});

describe("verifyTrackingLink", () => {
  it("validates a link produced by buildTrackingLink", () => {
    const { url } = buildTrackingLink({
      url: "https://koracn.com/guides/shanghai",
      growerName: "daniel",
      platform: "reddit",
      campaign: "autumn-launch",
      secret: SECRET,
    });

    const verification = verifyTrackingLink(url, SECRET);
    expect(verification).toMatchObject({
      valid: true,
      growerName: "daniel",
      platform: "reddit",
      campaign: "autumn-launch",
    });
  });

  it("rejects a tampered signature", () => {
    const { url } = buildTrackingLink({
      url: "https://koracn.com/guides/shanghai",
      growerName: "daniel",
      platform: "reddit",
      secret: SECRET,
    });
    const tampered = url.replace("kora_by=daniel", "kora_by=someoneelse");

    expect(verifyTrackingLink(tampered, SECRET)).toMatchObject({
      valid: false,
      reason: "signature_mismatch",
    });
  });

  it("rejects a link signed with a different secret", () => {
    const { url } = buildTrackingLink({
      url: "https://koracn.com/guides/shanghai",
      growerName: "daniel",
      platform: "reddit",
      secret: SECRET,
    });

    expect(verifyTrackingLink(url, "wrong-secret")).toMatchObject({
      valid: false,
      reason: "signature_mismatch",
    });
  });

  it("rejects links missing required fields", () => {
    expect(verifyTrackingLink("https://koracn.com/guides/shanghai", SECRET)).toMatchObject({
      valid: false,
      reason: "missing_fields",
    });
  });

  it("rejects invalid urls", () => {
    expect(verifyTrackingLink("not a url", SECRET)).toMatchObject({
      valid: false,
      reason: "invalid_url",
    });
  });
});
