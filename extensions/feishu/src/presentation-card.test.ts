import { normalizeMessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { describe, expect, it } from "vitest";
import {
  buildFeishuPresentationCard,
  feishuCardWithinTableLimit,
  isFeishuCardWithinEnvelope,
  shouldUseCard,
  withinCardTableLimit,
} from "./presentation-card.js";

describe("buildFeishuPresentationCard", () => {
  it("renders table blocks through the portable text fallback", () => {
    const presentation = normalizeMessagePresentation({
      blocks: [
        {
          type: "table",
          caption: "Pipeline",
          headers: ["Account", "Stage", "ARR"],
          rows: [
            ["Acme", "Won", 125000],
            ["Globex", "Review", 82000],
          ],
        },
      ],
    });
    if (!presentation) {
      throw new Error("expected valid presentation");
    }

    expect(buildFeishuPresentationCard({ presentation }).body.elements).toEqual([
      {
        tag: "markdown",
        content:
          "Pipeline (table)\n- Account: Acme; Stage: Won; ARR: 125000\n- Account: Globex; Stage: Review; ARR: 82000",
      },
    ]);
  });

  // A context block is grey, and grey comes from an inline tag. A fence has to
  // open and close its own line, so the two cannot share one element.
  it.each([
    { tables: "code" as const, grey: false },
    { tables: "bullets" as const, grey: true },
  ])("renders a $tables context table the card can draw", ({ tables, grey }) => {
    const tableMarkdown = "| Name | Role |\n| --- | --- |\n| Ada | Lead |";
    const presentation = normalizeMessagePresentation({
      blocks: [{ type: "context", text: tableMarkdown }],
    });
    if (!presentation) {
      throw new Error("expected valid presentation");
    }
    const converted = convertMarkdownTables(tableMarkdown, tables);
    // Guard the fixture: the case only means anything while `code` still opens a fence.
    expect(converted.startsWith("```")).toBe(!grey);

    expect(
      buildFeishuPresentationCard({
        presentation,
        renderText: (text) => convertMarkdownTables(text, tables),
      }).body.elements,
    ).toEqual([
      {
        tag: "markdown",
        content: grey ? `<font color='grey'>${converted}</font>` : converted,
      },
    ]);
  });

  // The shared adapter cuts a block to the 4,000-character text limit before this
  // module runs, and `code` pads every cell and adds a fence afterwards, so a block
  // that arrived inside the limit can leave it. Each piece is its own element and
  // carries its own marker pair.
  it("splits a projected table that outgrows the card text limit", () => {
    const header = "Quarterly revenue attainment by named account owner";
    const tableMarkdown = [
      `| ${header} | n |`,
      "| --- | --- |",
      ...Array.from({ length: 80 }, (_entry, index) => `| r${index} | ${index % 10} |`),
    ].join("\n");
    const presentation = normalizeMessagePresentation({
      blocks: [{ type: "text", text: tableMarkdown }],
    });
    if (!presentation) {
      throw new Error("expected valid presentation");
    }
    // Guard the fixture: the case only means anything while the authored block fits the
    // limit and the projection pushes it past.
    expect(tableMarkdown.length).toBeLessThanOrEqual(4000);
    expect(convertMarkdownTables(tableMarkdown, "code").length).toBeGreaterThan(4000);

    const elements = buildFeishuPresentationCard({
      presentation,
      renderText: (text) => convertMarkdownTables(text, "code"),
    }).body.elements as { tag: string; content: string }[];

    expect(elements.length).toBeGreaterThan(1);
    for (const element of elements) {
      expect(element.tag).toBe("markdown");
      expect(element.content.length).toBeLessThanOrEqual(4000);
      // Each element closes what it opened.
      const markers = element.content.match(/^```/gmu) ?? [];
      expect(markers.length).toBe(2);
    }
    const joined = elements.map((element) => element.content).join("");
    expect(joined).toContain(header);
    expect(joined).toContain("r0");
    expect(joined).toContain("r79");
  });
});

describe("isFeishuCardWithinEnvelope", () => {
  it("counts nested elements against the 200-element API limit", () => {
    const buildCard = (elementCount: number) => ({
      schema: "2.0",
      body: {
        elements: Array.from({ length: elementCount }, (_entry, index) => ({
          tag: "markdown",
          content: String(index),
        })),
      },
    });

    expect(isFeishuCardWithinEnvelope(buildCard(200))).toBe(true);
    expect(isFeishuCardWithinEnvelope(buildCard(201))).toBe(false);
  });
});

describe("withinCardTableLimit (parser-backed table counting)", () => {
  const pipedTable = "| a | b |\n| - | - |\n| 1 | 2 |";
  const pipelessTable = "a | b\n--- | ---\n1 | 2";
  const repeat = (table: string, count: number) =>
    Array.from({ length: count }, () => table).join("\n\n");

  it("accepts piped and pipe-less GFM tables at the 5-table boundary", () => {
    expect(withinCardTableLimit(repeat(pipedTable, 5))).toBe(true);
    expect(withinCardTableLimit(repeat(pipedTable, 6))).toBe(false);
    expect(withinCardTableLimit(repeat(pipelessTable, 5))).toBe(true);
    expect(withinCardTableLimit(repeat(pipelessTable, 6))).toBe(false);
  });

  it("counts alignment-colon delimiters toward the limit", () => {
    const alignPiped = "| a | b |\n|:--|--:|\n| 1 | 2 |";
    const alignPipeless = "c | d\n:---: | ---\n3 | 4";
    expect(withinCardTableLimit(repeat(alignPiped, 6))).toBe(false);
    expect(withinCardTableLimit(repeat(alignPipeless, 6))).toBe(false);
    expect(withinCardTableLimit(repeat(alignPiped, 5))).toBe(true);
  });

  it("does not count tables inside fenced code blocks", () => {
    expect(withinCardTableLimit("```\n" + repeat(pipedTable, 6) + "\n```")).toBe(true);
    expect(
      withinCardTableLimit("```\n" + repeat(pipedTable, 2) + "\n```\n\n" + repeat(pipedTable, 6)),
    ).toBe(false);
  });

  it("does not count thematic breaks or plain pipes in prose", () => {
    expect(withinCardTableLimit("---\n\nhello | world\n\n2024 | 2025")).toBe(true);
  });

  it("does not treat tables inside an HTML font wrapper as card table components", () => {
    expect(withinCardTableLimit(`<font color='grey'>${repeat(pipedTable, 6)}</font>`)).toBe(true);
  });
});

describe("feishuCardWithinTableLimit", () => {
  const table = "| a | b |\n| - | - |\n| 1 | 2 |";

  it("sums tables across all markdown elements of the card", () => {
    const card = {
      schema: "2.0",
      body: {
        elements: [
          { tag: "markdown", content: `${table}\n\n${table}\n\n${table}` },
          { tag: "hr" },
          { tag: "markdown", content: `${table}\n\n${table}\n\n${table}` },
        ],
      },
    };
    expect(feishuCardWithinTableLimit(card)).toBe(false);
  });

  it("accepts cards with at most 5 tables across elements", () => {
    const card = {
      schema: "2.0",
      body: {
        elements: [
          { tag: "markdown", content: `${table}\n\n${table}\n\n${table}` },
          { tag: "markdown", content: `${table}\n\n${table}` },
        ],
      },
    };
    expect(feishuCardWithinTableLimit(card)).toBe(true);
  });

  it("accepts cards without markdown tables", () => {
    const card = {
      schema: "2.0",
      body: { elements: [{ tag: "markdown", content: "plain | pipes but no table" }] },
    };
    expect(feishuCardWithinTableLimit(card)).toBe(true);
  });
});

describe("shouldUseCard (tables the card renderer will draw)", () => {
  const pipedTable = "| Name | Role |\n| --- | --- |\n| Ada | Lead |";
  const pipelessTable = "Name | Role\n---- | ----\nAda  | Lead";
  const quotedTable = "> Name | Role\n> ---- | ----\n> Ada  | Lead";
  const listTable = "- Name | Role\n  ---- | ----\n  Ada  | Lead";
  const orderedListTable = "1. Name | Role\n   ---- | ----\n   Ada  | Lead";

  it("promotes a table the renderer draws", () => {
    expect(shouldUseCard(pipedTable, true)).toBe(true);
    expect(shouldUseCard(pipelessTable, true)).toBe(true);
    expect(shouldUseCard("| a | b |\n|:--|--:|\n| 1 | 2 |", true)).toBe(true);
  });

  it("leaves a quoted table on the post path", () => {
    // The card renderer does not descend into the quote, so it would draw
    // neither the table nor its text. The post path converts it to a fence.
    expect(shouldUseCard(quotedTable, true)).toBe(false);
  });

  it("leaves a table opened by a list marker on the post path", () => {
    // Our parser reads the marker as part of the first header cell. The card
    // renderer reads it as a list item and draws an empty bullet.
    expect(shouldUseCard(listTable, true)).toBe(false);
    expect(shouldUseCard(orderedListTable, true)).toBe(false);
  });

  // Each of these parses to the first header cell `- Name`, exactly like the
  // list-opened table above, and none of them opens a list. Reading the parsed
  // cell instead of the source line would send all four to the post path.
  it.each([
    ["an outer pipe", "| - Name | Role |\n| --- | --- |\n| Ada | Lead |"],
    ["an escaped marker", "\\- Name | Role\n--- | ---\nAda | Lead"],
    ["an inline-code marker", "`- Name` | Role\n--- | ---\nAda | Lead"],
    ["an emphasized marker", "**- Name** | Role\n--- | ---\nAda | Lead"],
    ["an entity marker", "&#45; Name | Role\n--- | ---\nAda | Lead"],
  ])("still promotes a table whose first cell only looks like a marker: %s", (_label, text) => {
    expect(shouldUseCard(text, true)).toBe(true);
  });

  it("leaves a message mixing drawable and undrawable tables on the post path", () => {
    expect(shouldUseCard(`${pipedTable}\n\n${listTable}`, true)).toBe(false);
  });

  it("lets fenced code promote a message that also holds an undrawable table", () => {
    // Fenced code answers before tables are counted at all, so this is an
    // override rather than a table decision. The table in such a message is
    // still subject to the renderer limitation.
    expect(shouldUseCard("```js\nconst a = 1;\n```\n\n" + listTable, true)).toBe(true);
  });

  it("does not promote a table when the mode converts it first", () => {
    expect(shouldUseCard(pipedTable, false)).toBe(false);
    expect(shouldUseCard(quotedTable, false)).toBe(false);
  });

  it("does not promote prose that merely contains pipes", () => {
    expect(shouldUseCard("hello | world", true)).toBe(false);
  });
});
