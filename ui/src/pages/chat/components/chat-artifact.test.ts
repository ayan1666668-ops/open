import { describe, expect, it } from "vitest";
import { artifactPreviewLimit, classifyArtifact } from "./chat-artifact.ts";

describe("artifact classification", () => {
  it.each([
    ["notes.md", undefined, "markdown"],
    ["report.pdf", "application/octet-stream", "pdf"],
    ["forecast.xlsx", undefined, "spreadsheet"],
    ["launch.pptx", undefined, "presentation"],
    ["brief.docx", undefined, "docx"],
    ["main.ts", undefined, "code"],
    ["readme.txt", "text/plain; charset=utf-8", "text"],
    ["mystery.blob", "application/octet-stream", "unsupported"],
  ])("classifies %s", (filename, mime, expected) => {
    expect(classifyArtifact(filename, mime)).toBe(expected);
  });

  it("keeps preview ceilings aligned with the ClickClack contract", () => {
    expect(artifactPreviewLimit("code")).toBe(2 * 1024 * 1024);
    expect(artifactPreviewLimit("spreadsheet")).toBe(24 * 1024 * 1024);
    expect(artifactPreviewLimit("pdf")).toBe(64 * 1024 * 1024);
  });
});
