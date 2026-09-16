// Feishu-specific Markdown parsing and chunking.
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import { chunkMarkdownTextWithMode, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { MentionTarget } from "./mention-target.types.js";

/**
 * A fence opener may carry an info string and a closer may not, and both sit behind the
 * table's source prefix. Quote markers pass, and so do the three spaces of indentation a
 * fence is allowed: a fourth makes the line indented code rather than a fence, which is
 * where the shared scanner draws the line too. Matching nothing else keeps an inline
 * backtick run in ordinary prose, and a backtick line inside an indented code block, from
 * reading as a marker and suppressing a table that would have converted safely. A closer
 * keeps the carriage return of a CRLF source, since the line split is on the feed alone.
 */
const FEISHU_FENCE_OPENER = /^((?: {0,3}(?:>[ \t]?)+)?) {0,3}(`{3,})[^`]*$/u;
const FEISHU_FENCE_CLOSER = /^((?: {0,3}(?:>[ \t]?)+)?) {0,3}(`{3,})[ \t]*\r?$/u;

/** A quote prefix marks the container a fence lives in, and one optional space inside it
 * is decoration rather than depth. */
function fenceDepth(prefix: string): string {
  return prefix.replaceAll(/[ \t]/gu, "");
}

/**
 * A chunk that opens a fence nothing closes renders worse than the table it replaced, so
 * the conversion only runs when every chunk closes what it opened. A run shorter than the
 * one that opened the block is body text, which is how a cell carrying its own backticks
 * survives inside the longer marker the conversion gave it. A marker in a different
 * container is body text too: a quoted line inside a top-level block belongs to the block
 * and closes nothing.
 */
function fencesBalance(chunk: string): boolean {
  let openMarkerLength = 0;
  let openDepth = "";
  for (const line of chunk.split("\n")) {
    if (openMarkerLength === 0) {
      const opener = FEISHU_FENCE_OPENER.exec(line);
      openMarkerLength = opener?.[2]?.length ?? 0;
      openDepth = fenceDepth(opener?.[1] ?? "");
      continue;
    }
    const closer = FEISHU_FENCE_CLOSER.exec(line);
    const marker = closer?.[2];
    if (
      marker &&
      marker.length >= openMarkerLength &&
      fenceDepth(closer?.[1] ?? "") === openDepth
    ) {
      openMarkerLength = 0;
    }
  }
  return openMarkerLength === 0;
}

function isFenceMarkerLine(line: string): boolean {
  return FEISHU_FENCE_OPENER.test(line) || FEISHU_FENCE_CLOSER.test(line);
}

/**
 * `code` mode wraps each table in a fence, and the chunker closes and reopens that fence
 * at every boundary it cuts. It cannot do that for every shape. A cell's backticks
 * lengthen the marker, an indent widens the line the chunker has to fit twice, and a
 * quote prefix hides the marker from the fence scanner entirely, which no limit repairs.
 * Below a handful of characters the cut lands inside the marker and delivers backtick
 * fragments instead. Rather than model that budget, cut the converted text the way the
 * send will and ask three things of the pieces: each one stays inside the limit, each one
 * closes what it opened, and every marker arrives whole.
 */
export function fencesSurvive(converted: string, chunks: readonly string[]): boolean {
  if (!chunks.every(fencesBalance)) {
    return false;
  }
  const delivered = new Set(
    chunks.flatMap((chunk) => chunk.split("\n")).map((line) => line.trim()),
  );
  return converted
    .split("\n")
    .every((line) => !isFenceMarkerLine(line) || delivered.has(line.trim()));
}

export function chunkedFencesBalance(converted: string, limit: number, mode: ChunkMode): boolean {
  const chunks = chunkMarkdownTextWithMode(converted, limit, mode);
  return chunks.every((chunk) => chunk.length <= limit) && fencesSurvive(converted, chunks);
}

export type FeishuMarkdownNode = {
  type: string;
  depth?: number;
  identifier?: string;
  url?: string;
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
  children?: FeishuMarkdownNode[];
};

type FeishuPostMessageElement =
  | { tag: "at"; user_id: string; user_name?: string }
  | { tag: "md"; text: string };

const FEISHU_POST_MAX_BYTES = 30 * 1024;

/** One parser contract for Feishu message and document Markdown decisions. */
export function parseFeishuMarkdown(text: string): FeishuMarkdownNode {
  return fromMarkdown(text, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  }) as FeishuMarkdownNode;
}

function buildFeishuPostMentionElements(mentions?: MentionTarget[]): FeishuPostMessageElement[] {
  if (!mentions?.length) {
    return [];
  }

  const elements: FeishuPostMessageElement[] = [];
  for (const mention of mentions) {
    const userId = mention.openId.trim();
    if (!userId) {
      continue;
    }
    const userName = mention.name.trim();
    elements.push({
      tag: "at",
      user_id: userId,
      ...(userName ? { user_name: userName } : {}),
    });
  }
  return elements;
}

export function buildFeishuPostMessageContent(params: {
  messageText: string;
  mentions?: MentionTarget[];
}): string {
  const content: FeishuPostMessageElement[] = [
    ...buildFeishuPostMentionElements(params.mentions),
    {
      tag: "md",
      text: params.messageText,
    },
  ];
  return JSON.stringify({
    zh_cn: {
      content: [content],
    },
  });
}

export function feishuPostWithinEnvelope(content: string): boolean {
  return Buffer.byteLength(content, "utf8") <= FEISHU_POST_MAX_BYTES;
}

export function assertFeishuPostWithinEnvelope(content: string, label: string): void {
  if (!feishuPostWithinEnvelope(content)) {
    throw new Error(`${label} exceeds the 30 KB rich-post API limit`);
  }
}

function collectSoftBreakOffsets(text: string): number[] {
  const root = parseFeishuMarkdown(text);
  const offsets: number[] = [];
  const pending = [root];

  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) {
      continue;
    }
    if (node.children) {
      pending.push(...node.children);
    }
    if (node.type !== "text") {
      continue;
    }

    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) {
      continue;
    }
    for (let offset = start; offset < end; offset += 1) {
      const char = text[offset];
      if (char === "\n") {
        if (text[offset - 1] !== "\r") {
          offsets.push(offset);
        }
        continue;
      }
      if (char === "\r") {
        offsets.push(offset);
        if (text[offset + 1] === "\n") {
          offset += 1;
        }
      }
    }
  }

  return offsets.toSorted((left, right) => left - right);
}

/**
 * Materialize CommonMark soft breaks for Feishu post `md` rendering.
 *
 * The parser identifies only soft breaks, then upgrades them to CommonMark
 * hard breaks. Structural line endings and code, HTML, definitions, setext
 * headings, and existing hard breaks retain their source bytes.
 */
export function materializeFeishuPostMarkdownSoftBreaks(text: string): string {
  if (!text.includes("\n") && !text.includes("\r")) {
    return text;
  }

  const softBreakOffsets = collectSoftBreakOffsets(text);
  if (softBreakOffsets.length === 0) {
    return text;
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const offset of softBreakOffsets) {
    const lineEnding = text[offset] === "\r" ? (text[offset + 1] === "\n" ? "\r\n" : "\r") : "\n";
    parts.push(text.slice(cursor, offset), "  ", lineEnding);
    cursor = offset + lineEnding.length;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

function chunkFeishuMarkdownWithMode(text: string, limit: number, mode: ChunkMode): string[] {
  return chunkMarkdownTextWithMode(text, limit, mode);
}

/** Keep every platform chunk independently valid Markdown, including fences. */
export function chunkFeishuMarkdown(text: string, limit: number): string[] {
  return chunkFeishuMarkdownWithMode(text, limit, "length");
}

function postContentBytes(messageText: string, mentions?: MentionTarget[]): number {
  return Buffer.byteLength(buildFeishuPostMessageContent({ messageText, mentions }), "utf8");
}

/**
 * Honor both configured character chunking and Feishu's serialized post envelope.
 * Markdown wrappers and first-chunk mentions count toward the byte budget.
 */
export type FeishuMarkdownChunkOptions = {
  text: string;
  limit: number;
  mode?: ChunkMode;
  firstChunkMentions?: MentionTarget[];
  chunkMentions?: MentionTarget[];
  initialChunks?: string[];
};

export function chunkFeishuPostMarkdown(params: FeishuMarkdownChunkOptions): string[] {
  return chunkFeishuMarkdownByEnvelope({
    ...params,
    contentBytes: (text, isFirst) =>
      postContentBytes(text, [
        ...(params.chunkMentions ?? []),
        ...(isFirst ? (params.firstChunkMentions ?? []) : []),
      ]),
  });
}

/**
 * The post chunker owns its own envelope, so the size question is already settled and only
 * the markers are in doubt. A quote-prefixed marker is invisible to the fence scanner, so
 * a converted blockquoted table cannot be closed and reopened at a cut and its two markers
 * land in different messages.
 */
export function postFencesSurvive(converted: string, params: FeishuMarkdownChunkOptions): boolean {
  return fencesSurvive(converted, chunkFeishuPostMarkdown(params));
}

/** Measure the actual transport envelope, including UTF-8, JSON escapes and fence wrappers. */
export function chunkFeishuMarkdownByEnvelope(
  params: FeishuMarkdownChunkOptions & {
    contentBytes: (text: string, isFirst: boolean) => number;
  },
): string[] {
  const { text } = params;
  if (!text) {
    return [];
  }

  const requestedLimit =
    Number.isFinite(params.limit) && params.limit > 0 ? Math.floor(params.limit) : text.length;
  const initialChunks =
    params.initialChunks ??
    chunkFeishuMarkdownWithMode(text, requestedLimit, params.mode ?? "length");
  const output: string[] = [];
  for (const initialChunk of initialChunks) {
    if (params.contentBytes(initialChunk, output.length === 0) <= FEISHU_POST_MAX_BYTES) {
      output.push(initialChunk);
      continue;
    }

    let adaptiveLimit = Math.max(1, Math.min(requestedLimit, initialChunk.length));

    while (true) {
      const chunks = chunkFeishuMarkdownWithMode(
        initialChunk,
        adaptiveLimit,
        params.mode ?? "length",
      );
      let largestContentBytes = 0;
      let oversizedChunk: string | undefined;

      for (const [index, chunk] of chunks.entries()) {
        const contentBytes = params.contentBytes(chunk, output.length === 0 && index === 0);
        largestContentBytes = Math.max(largestContentBytes, contentBytes);
        if (contentBytes > FEISHU_POST_MAX_BYTES && oversizedChunk === undefined) {
          oversizedChunk = chunk;
        }
      }

      if (oversizedChunk === undefined) {
        output.push(...chunks);
        break;
      }
      if (adaptiveLimit === 1) {
        throw new Error("Feishu Markdown chunk exceeds the 30 KB API limit");
      }

      // Scale by the observed serialized size, then force progress for envelope
      // overhead or Markdown fence wrappers that do not shrink with source text.
      adaptiveLimit = Math.max(
        1,
        Math.min(
          adaptiveLimit - 1,
          Math.floor((adaptiveLimit * FEISHU_POST_MAX_BYTES) / largestContentBytes) - 1,
        ),
      );
    }
  }

  return output;
}
