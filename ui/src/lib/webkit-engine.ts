// Blink and the DOM test environments froze their token at AppleWebKit/537.36;
// WebKit itself (Safari, every iOS browser, WKWebView hosts) reports 605+.
const WEBKIT_ENGINE_MIN_BUILD = 600;

/** True when the page runs on the WebKit engine rather than Blink or Gecko. */
export function isWebKitEngine(userAgent = globalThis.navigator?.userAgent ?? ""): boolean {
  const match = /AppleWebKit\/(\d+)/u.exec(userAgent);
  return match !== null && Number(match[1]) >= WEBKIT_ENGINE_MIN_BUILD;
}
