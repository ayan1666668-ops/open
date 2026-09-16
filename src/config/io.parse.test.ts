// Covers config file parsing errors and JSON5 compatibility behavior.
import { describe, expect, it, vi } from "vitest";
import { parseConfigJson5 } from "./config.js";

describe("parseConfigJson5", () => {
  it("uses native JSON parsing before JSON5 fallback", () => {
    const json5 = { parse: vi.fn(() => ({ fromJson5: true })) };

    const result = parseConfigJson5('{"gateway":{"mode":"local"}}', json5);

    expect(result).toEqual({ ok: true, parsed: { gateway: { mode: "local" } } });
    expect(json5.parse).not.toHaveBeenCalled();
  });

  it("falls back to JSON5 for authored config syntax", () => {
    const json5 = { parse: vi.fn(() => ({ gateway: { mode: "local" } })) };

    const result = parseConfigJson5("{ gateway: { mode: 'local' } }", json5);

    expect(result).toEqual({ ok: true, parsed: { gateway: { mode: "local" } } });
    expect(json5.parse).toHaveBeenCalledOnce();
  });

  it("keeps a CR-terminated comment from hiding the value that follows it", () => {
    // The comment ends at the carriage return; the quoted value continues on the
    // next line and holds 513 literal brackets that belong to the string, not to
    // the config structure.
    const raw = `// don't\r"${"\\\n"}${"[".repeat(513)}"`;

    expect(parseConfigJson5(raw)).toEqual({ ok: true, parsed: "[".repeat(513) });
  });

  it("rejects a config file whose real nesting exceeds the limit", () => {
    const result = parseConfigJson5(`${"[".repeat(600)}${"]".repeat(600)}`);

    expect(result.ok).toBe(false);
    expect("error" in result && result.error).toContain("nesting depth exceeds maximum");
  });
});
