import { describe, expect, it } from "vitest";
import { isWebKitEngine } from "./webkit-engine.ts";

const SAFARI_MACOS =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.3 Safari/605.1.15";
const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const WKWEBVIEW_MACOS =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const CHROME_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/152.0.0.0 Mobile/15E148 Safari/604.1";
const CHROME_MACOS =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const EDGE_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0";
const FIREFOX_MACOS =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15.7; rv:157.0) Gecko/20100101 Firefox/157.0";
const JSDOM = "Mozilla/5.0 (darwin) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/27.0.0";

describe("isWebKitEngine", () => {
  it("detects Safari, iOS browsers, and WKWebView hosts", () => {
    expect(isWebKitEngine(SAFARI_MACOS)).toBe(true);
    expect(isWebKitEngine(SAFARI_IOS)).toBe(true);
    expect(isWebKitEngine(WKWEBVIEW_MACOS)).toBe(true);
    expect(isWebKitEngine(CHROME_IOS)).toBe(true);
  });

  it("rejects Blink, Gecko, and DOM test environments", () => {
    expect(isWebKitEngine(CHROME_MACOS)).toBe(false);
    expect(isWebKitEngine(EDGE_WINDOWS)).toBe(false);
    expect(isWebKitEngine(FIREFOX_MACOS)).toBe(false);
    expect(isWebKitEngine(JSDOM)).toBe(false);
    expect(isWebKitEngine("")).toBe(false);
  });
});
