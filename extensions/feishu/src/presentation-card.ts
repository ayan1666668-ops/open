// Feishu plugin module implements presentation card behavior.
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import {
  adaptMessagePresentationForChannel,
  legacyInteractiveReplyToPresentation,
  normalizeLegacyInteractiveReply,
  normalizeMessagePresentation,
  renderMessagePresentationChartFallbackText,
  renderPresentationForDelivery,
  renderMessagePresentationFallbackText,
  renderMessagePresentationTableFallbackText,
  resolveLegacyInteractiveTextFallback,
  type MessagePresentationBlock,
  type MessagePresentationButton,
} from "openclaw/plugin-sdk/interactive-runtime";
import { getMarkdownTableSource } from "openclaw/plugin-sdk/markdown-table-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { markdownToIRWithMeta } from "openclaw/plugin-sdk/text-chunking";
import type { OutboundIdentity, ReplyPayload } from "../runtime-api.js";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import { parseFeishuCommentTarget } from "./comment-target.js";
import { resolveFeishuIdentityHeaderTitle } from "./identity-header.js";
import { chunkFeishuMarkdown, fencesSurvive } from "./markdown.js";
import type { MentionTarget } from "./mention-target.types.js";
import { buildMentionedCardContent } from "./mention.js";
import {
  escapeFeishuCardMarkdownText,
  escapeFeishuCardPlainText,
  resolveSafeFeishuButtonUrl,
  readNativeFeishuCardJson,
  sanitizeNativeFeishuCard,
  type FeishuNativeCard,
} from "./native-card.js";

type NormalizedMessagePresentation = NonNullable<ReturnType<typeof normalizeMessagePresentation>>;
type FeishuPresentationTextFormat = "plain" | "markdown";
const RENDERED_FEISHU_CARD = Symbol("openclaw.renderedFeishuCard");
const FEISHU_PRESENTATION_FALLBACK_MARKER = "__openclawPresentationFallback";

export const FEISHU_PRESENTATION_CAPABILITIES = {
  supported: true,
  buttons: true,
  selects: false,
  context: true,
  divider: true,
  limits: {
    actions: {
      maxActions: 20,
      maxActionsPerRow: 5,
      maxLabelLength: 40,
      maxValueBytes: 1024,
    },
    text: {
      maxLength: 4000,
      encoding: "characters",
      markdownDialect: "markdown",
    },
  },
} satisfies NonNullable<ChannelOutboundAdapter["presentationCapabilities"]>;

const FEISHU_CARD_TEXT_MAX_LENGTH = FEISHU_PRESENTATION_CAPABILITIES.limits.text.maxLength;
const FEISHU_CARD_GREY_OPEN = "<font color='grey'>";
const FEISHU_CARD_GREY_CLOSE = "</font>";
const FEISHU_CARD_GREY_LENGTH = FEISHU_CARD_GREY_OPEN.length + FEISHU_CARD_GREY_CLOSE.length;

/**
 * The shared adapter splits a block to the text limit above before this module sees it,
 * and `code` mode then pads every cell and adds a fence, so a block that arrived inside
 * the limit can leave it. Split the projected form back, with the chunker that closes and
 * reopens a fence rather than cutting one in half, and give each piece its own element.
 */
function escapedLength(text: string): number {
  return escapeFeishuCardMarkdownText(text).length;
}

// The element carries the escaped text, and escaping turns one `&`, `<` or `>` into four
// or five characters after the cut has already been made. Cutting the escaped text
// instead would split an entity, so the budget comes down from the limit by whatever the
// longest part actually measured, until the escaped parts fit.
function fitBlockParts(text: string, ceiling: number): string[] {
  let budget = ceiling;
  let parts = chunkFeishuMarkdown(text, budget);
  for (let attempt = 0; attempt < 8 && parts.length > 0; attempt += 1) {
    const longest = Math.max(...parts.map(escapedLength));
    if (longest <= ceiling) {
      return parts;
    }
    const next = Math.floor((budget * ceiling) / longest);
    if (next < 1 || next >= budget) {
      break;
    }
    budget = next;
    parts = chunkFeishuMarkdown(text, budget);
  }
  return parts;
}

function projectBlockText(
  text: string,
  renderText: (text: string) => string,
  reserve = 0,
): string[] {
  const ceiling = FEISHU_CARD_TEXT_MAX_LENGTH - reserve;
  const rendered = renderText(text);
  if (escapedLength(rendered) + reserve <= FEISHU_CARD_TEXT_MAX_LENGTH) {
    return [rendered];
  }
  const parts = fitBlockParts(rendered, ceiling);
  // A quote prefix hides a fence marker from the chunker's scanner, so a quoted table
  // long enough to need several elements leaves its opening fence in one and its closing
  // fence in another, and neither draws a block. The send paths answer this the same way:
  // a conversion the cut cannot carry gives way to the authored text, which is the form
  // the shared adapter would have cut anyway.
  if (rendered !== text && parts.length > 0 && !fencesSurvive(rendered, parts)) {
    const authored = fitBlockParts(text, ceiling);
    if (authored.length > 0) {
      return authored;
    }
  }
  return parts.length ? parts : [rendered];
}

const FEISHU_CARD_MAX_BYTES = 30 * 1024;
const FEISHU_CARD_MAX_ELEMENTS = 200;

export function resolveFeishuRichReply(payload: { interactive?: unknown; presentation?: unknown }) {
  const interactive = normalizeLegacyInteractiveReply(payload.interactive);
  return {
    interactive,
    presentation:
      normalizeMessagePresentation(payload.presentation) ??
      (interactive ? legacyInteractiveReplyToPresentation(interactive) : undefined),
  };
}

export function buildFeishuPresentationFallback(params: {
  text?: string;
  presentation?: NormalizedMessagePresentation;
  fallbackHasCommand?: boolean;
  textFormat?: FeishuPresentationTextFormat;
}) {
  const fallbackText = renderFeishuPresentationFallbackText(params, params.textFormat);
  // Only warn when the rendered fallback exposes a command the user can copy.
  const fallbackHasCommand =
    params.fallbackHasCommand === true ||
    params.presentation?.blocks.some((block) =>
      block.type === "select"
        ? block.options.some(({ action }) => action?.type === "command")
        : block.type === "buttons" &&
          block.buttons.some(({ action, disabled }) => !disabled && action?.type === "command"),
    ) === true;
  return {
    fallbackText,
    fallbackHasCommand,
    commentText: fallbackHasCommand
      ? `${fallbackText}\n\n> Interactive buttons are unavailable in Feishu document comments. You can type the command shown above manually.`
      : fallbackText,
  };
}

function countFeishuCardElements(value: unknown, ancestors = new Set<object>()): number {
  if (Array.isArray(value)) {
    return value.reduce((count, entry) => count + countFeishuCardElements(entry, ancestors), 0);
  }
  if (!isRecord(value)) {
    return 0;
  }
  if (ancestors.has(value)) {
    return FEISHU_CARD_MAX_ELEMENTS + 1;
  }
  ancestors.add(value);
  let count = typeof value.tag === "string" ? 1 : 0;
  for (const entry of Object.values(value)) {
    count += countFeishuCardElements(entry, ancestors);
    if (count > FEISHU_CARD_MAX_ELEMENTS) {
      break;
    }
  }
  ancestors.delete(value);
  return count;
}

export function isFeishuCardWithinEnvelope(card: Record<string, unknown>): boolean {
  try {
    return (
      Buffer.byteLength(JSON.stringify(card), "utf8") <= FEISHU_CARD_MAX_BYTES &&
      countFeishuCardElements(card) <= FEISHU_CARD_MAX_ELEMENTS
    );
  } catch {
    return false;
  }
}

export function assertFeishuCardWithinEnvelope(
  card: Record<string, unknown>,
  label = "Feishu card",
): void {
  if (!isFeishuCardWithinEnvelope(card)) {
    throw new Error(`${label} exceeds the 30 KB or 200-element API limit.`);
  }
}

/** Feishu allows at most five table components per static interactive card. */
const FEISHU_CARD_TABLE_LIMIT = 5;

// A source line that opens a list. Our parser reads `- Name | Role` as a table
// whose first cell is `- Name`; the card renderer reads the same line as a list
// item and finds no table under it. This is tested against the original line
// rather than the parsed cell, because `| - Name | Role |`, an escaped marker,
// an inline-code marker and an emphasized marker all parse to the cell
// `- Name` while none of them opens a list.
const CARD_TABLE_LIST_OPENER = /^\s*(?:[-*+]|\d+[.)])\s/u;

/**
 * Counts the tables in `text` twice: how many the parser finds, and how many of
 * those are eligible to be drawn there.
 *
 * The two numbers differ because the card renderer's Markdown is not ours. It
 * does not descend into a blockquote, and it claims a leading list marker for a
 * list. In both cases it draws nothing at all for the table rather than falling
 * back to its text, so the rows leave the message. The post path renders both
 * shapes, because it converts them to a fenced block first.
 */
function countMarkdownTables(text: string): { total: number; drawable: number } {
  // GFM table headers require a literal pipe.
  if (!text.includes("|")) {
    return { total: 0, drawable: 0 };
  }
  const { tables } = markdownToIRWithMeta(text, { tableMode: "block" });
  let drawable = 0;
  for (const table of tables) {
    const source = getMarkdownTableSource(table);
    if (!source || source.prefix) {
      continue;
    }
    const headerLine = text.slice(source.start).split("\n", 1)[0] ?? "";
    if (CARD_TABLE_LIST_OPENER.test(headerLine)) {
      continue;
    }
    drawable += 1;
  }
  return { total: tables.length, drawable };
}

export function withinCardTableLimit(text: string): boolean {
  // Counts every table, not just the drawable ones: staying under the component
  // limit by ignoring tables is the wrong kind of cheap.
  return countMarkdownTables(text).total <= FEISHU_CARD_TABLE_LIMIT;
}

/**
 * Whether the parser finds a table in this text at all. `off` uses this to keep
 * a raw table off a card, where the card renderer would parse its pipes.
 */
export function hasCardMarkdownTable(text: string): boolean {
  return countMarkdownTables(text).total > 0;
}

/**
 * Whether this text carries a table the card renderer is not expected to draw.
 * Every path that can commit a card has to ask this, not only ordinary send
 * routing, or the rows leave the message on whichever path skipped it.
 */
export function hasUndrawableCardTable(text: string): boolean {
  const { total, drawable } = countMarkdownTables(text);
  return total > drawable;
}

/**
 * Fenced code promotes a message to a card. A table promotes it only when the
 * card renderer is expected to draw every table in it, since one it does not draw
 * is dropped from the message instead of degrading.
 */
export function shouldUseCard(text: string, nativeTables: boolean): boolean {
  if (/```[\s\S]*?```/.test(text)) {
    return true;
  }
  if (!nativeTables) {
    return false;
  }
  const { total, drawable } = countMarkdownTables(text);
  return total > 0 && drawable === total;
}

/**
 * A card carries a table as one component, and the card chunker cuts on lines without
 * repeating the header and its delimiter, so every card after the first shows those rows
 * as raw pipes. A table that does not fit one card belongs on the post path, which renders
 * it as a fenced block that survives the cut. One rule, asked at every place that promotes
 * text to a card.
 */
export function cardCarriesWholeTable(
  text: string,
  chunk: (text: string) => readonly string[],
): boolean {
  return !hasCardMarkdownTable(text) || chunk(text).length <= 1;
}

export function feishuCardWithinTableLimit(card: Record<string, unknown>): boolean {
  let remaining = FEISHU_CARD_TABLE_LIMIT;
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) {
      return value.every(visit);
    }
    if (!isRecord(value)) {
      return true;
    }
    if (value.tag === "markdown" && typeof value.content === "string") {
      remaining -= countMarkdownTables(value.content).total;
    }
    return remaining >= 0 && Object.values(value).every(visit);
  };
  return visit(card);
}

function resolveFeishuButtonUrl(button: MessagePresentationButton): string | undefined {
  if (button.action?.type === "url" || button.action?.type === "web-app") {
    return button.action.url;
  }
  if (button.action) {
    return undefined;
  }
  return button.url ?? button.webApp?.url ?? button.web_app?.url;
}

function resolveFeishuCommandButtonValue(button: MessagePresentationButton): string | undefined {
  if (button.action?.type === "command") {
    return button.action.command;
  }
  if (button.action) {
    return undefined;
  }
  return button.value;
}

export function renderFeishuPresentationFallbackText(
  params: Parameters<typeof renderMessagePresentationFallbackText>[0],
  textFormat: FeishuPresentationTextFormat = "plain",
): string {
  const presentation = params.presentation;
  return renderMessagePresentationFallbackText({
    ...params,
    presentation: presentation && {
      ...presentation,
      blocks: presentation.blocks.map((block) =>
        block.type === "buttons"
          ? {
              type: block.type,
              buttons: block.buttons.map((button) => {
                const url = resolveFeishuButtonUrl(button);
                // Reject the same targets everywhere; only Markdown transports escape labels.
                return {
                  ...button,
                  ...(textFormat === "markdown"
                    ? { label: escapeFeishuCardPlainText(button.label) }
                    : {}),
                  ...(url && !resolveSafeFeishuButtonUrl(url) ? { disabled: true } : {}),
                };
              }),
            }
          : block,
      ),
    },
  });
}

function mapFeishuButtonType(style: MessagePresentationButton["style"]) {
  if (style === "primary" || style === "success") {
    return "primary";
  }
  if (style === "danger") {
    return "danger";
  }
  return "default";
}

function buildFeishuPayloadButton(button: MessagePresentationButton): Record<string, unknown> {
  const url = resolveSafeFeishuButtonUrl(resolveFeishuButtonUrl(button));
  const value = resolveFeishuCommandButtonValue(button);
  if (button.disabled || (!url && !value)) {
    // Keep each unavailable control visible without exposing rejected URLs or opaque values.
    return { tag: "markdown", content: `- ${escapeFeishuCardPlainText(button.label)}` };
  }
  const behaviors: Record<string, unknown>[] = [];
  if (url) {
    behaviors.push({ type: "open_url", default_url: url });
  }
  if (value) {
    behaviors.push({
      type: "callback",
      value: createFeishuCardInteractionEnvelope({
        k: "quick",
        a: "feishu.payload.button",
        q: value,
      }),
    });
  }
  return {
    tag: "button",
    text: { tag: "plain_text", content: button.label },
    type: mapFeishuButtonType(button.style),
    behaviors,
  };
}

function buildFeishuCardElementsForBlock(
  block: MessagePresentationBlock,
  renderText: (text: string) => string,
): Record<string, unknown>[] {
  if (block.type === "text") {
    return projectBlockText(block.text, renderText).map((part) => ({
      tag: "markdown",
      content: escapeFeishuCardMarkdownText(part),
    }));
  }
  if (block.type === "context") {
    // `code` mode hands this block a fenced table, and a fence only opens and closes
    // at the start of its own line. Inside the color tag those markers stop being
    // fences and the rows arrive as literal text, so a context block carrying one
    // keeps its shape and gives up the grey.
    // The colour tag is added after the split, so its own characters come out of the
    // budget the parts are sized to. A part carrying a fence gives the tag up and could
    // have had them back, which costs a little room rather than an oversized element.
    return projectBlockText(block.text, renderText, FEISHU_CARD_GREY_LENGTH).map((part) => {
      const content = escapeFeishuCardMarkdownText(part);
      return {
        tag: "markdown",
        content: /```[\s\S]*?```/.test(content)
          ? content
          : `${FEISHU_CARD_GREY_OPEN}${content}${FEISHU_CARD_GREY_CLOSE}`,
      };
    });
  }
  if (block.type === "divider") {
    return [{ tag: "hr" }];
  }
  if (block.type === "buttons") {
    return block.buttons.map(buildFeishuPayloadButton);
  }
  if (block.type === "chart") {
    return [
      {
        tag: "markdown",
        content: escapeFeishuCardMarkdownText(
          renderText(renderMessagePresentationChartFallbackText(block)),
        ),
      },
    ];
  }
  if (block.type === "table") {
    return [
      {
        tag: "markdown",
        content: escapeFeishuCardMarkdownText(
          renderText(renderMessagePresentationTableFallbackText(block)),
        ),
      },
    ];
  }
  return [
    {
      tag: "markdown",
      content: escapeFeishuCardMarkdownText(
        renderText(renderMessagePresentationFallbackText({ presentation: { blocks: [block] } })),
      ),
    },
  ];
}

function resolvePresentationHeaderTemplate(tone: NormalizedMessagePresentation["tone"]) {
  if (tone === "danger") {
    return "red";
  }
  if (tone === "warning") {
    return "orange";
  }
  if (tone === "success") {
    return "green";
  }
  return "blue";
}

function buildFeishuPresentationCardElements(params: {
  presentation: NormalizedMessagePresentation;
  fallbackText?: string;
  renderText?: (text: string) => string;
}): Record<string, unknown>[] {
  const elements: Record<string, unknown>[] = [];
  const renderText = params.renderText ?? ((text: string) => text);
  const fallbackText = params.fallbackText?.trim();
  if (fallbackText) {
    // The fallback is projected like any block and outgrows the limit the same way.
    for (const part of projectBlockText(fallbackText, renderText)) {
      elements.push({ tag: "markdown", content: escapeFeishuCardMarkdownText(part) });
    }
  }
  for (const block of params.presentation.blocks) {
    for (const element of buildFeishuCardElementsForBlock(block, renderText)) {
      elements.push(element);
    }
  }
  if (elements.length > 0) {
    return elements;
  }
  return [{ tag: "markdown", content: "" }];
}

export function buildFeishuPresentationCard(params: {
  presentation: NormalizedMessagePresentation;
  fallbackText?: string;
  renderText?: (text: string) => string;
}): FeishuNativeCard {
  return {
    schema: "2.0",
    config: {
      width_mode: "fill",
    },
    ...(params.presentation.title
      ? {
          header: {
            title: { tag: "plain_text", content: params.presentation.title },
            template: resolvePresentationHeaderTemplate(params.presentation.tone),
          },
        }
      : {}),
    body: {
      elements: buildFeishuPresentationCardElements(params),
    },
  };
}

export function markRenderedFeishuCard(card: FeishuNativeCard): FeishuNativeCard {
  Object.defineProperty(card, RENDERED_FEISHU_CARD, {
    value: true,
    enumerable: false,
  });
  return card;
}

export function readNativeFeishuCard(payload: { channelData?: Record<string, unknown> }) {
  const feishuData = payload.channelData?.feishu;
  if (!isRecord(feishuData)) {
    return undefined;
  }
  const card = feishuData.card ?? feishuData.interactiveCard;
  if (!isRecord(card)) {
    return undefined;
  }
  const rendered = card as FeishuNativeCard & { [RENDERED_FEISHU_CARD]?: true };
  if (rendered[RENDERED_FEISHU_CARD] === true) {
    return rendered;
  }
  const sanitizedCard = sanitizeNativeFeishuCard(card);
  return sanitizedCard ? markRenderedFeishuCard(sanitizedCard) : undefined;
}

export function consumeFeishuPresentationFallbackMarker(payload: ReplyPayload): {
  payload: ReplyPayload;
  presentationFallback?: { hasVisibleContent: boolean };
} {
  const feishuData = isRecord(payload.channelData?.feishu) ? payload.channelData.feishu : undefined;
  const presentationFallback = feishuData?.[FEISHU_PRESENTATION_FALLBACK_MARKER];
  if (
    !isRecord(presentationFallback) ||
    typeof presentationFallback.hasVisibleContent !== "boolean"
  ) {
    return { payload };
  }
  const nextFeishuData = { ...feishuData };
  delete nextFeishuData[FEISHU_PRESENTATION_FALLBACK_MARKER];
  const nextChannelData = { ...payload.channelData };
  if (Object.keys(nextFeishuData).length > 0) {
    nextChannelData.feishu = nextFeishuData;
  } else {
    delete nextChannelData.feishu;
  }
  return {
    payload: {
      ...payload,
      channelData: Object.keys(nextChannelData).length > 0 ? nextChannelData : undefined,
    },
    presentationFallback: { hasVisibleContent: presentationFallback.hasVisibleContent },
  };
}

export function buildFeishuPayloadCard(params: {
  payload: ReplyPayload;
  text?: string;
  identity?: OutboundIdentity;
  mentions?: MentionTarget[];
  renderText?: (text: string) => string;
}): FeishuNativeCard | undefined {
  const nativeCard = readNativeFeishuCard(params.payload);
  const rawText = params.text ?? params.payload.text;
  const textCard = readNativeFeishuCardJson(rawText);
  const { interactive, presentation } = resolveFeishuRichReply(params.payload);
  let card = nativeCard ?? (!presentation ? textCard : undefined);
  const isNativeCard = card !== undefined;
  if (!card && presentation) {
    card = buildFeishuPresentationCard({
      renderText: params.renderText,
      presentation: {
        ...presentation,
        title: presentation.title ?? resolveFeishuIdentityHeaderTitle(params.identity),
      },
      fallbackText: textCard
        ? undefined
        : resolveLegacyInteractiveTextFallback({ text: rawText, interactive }),
    });
  }
  if (!card) {
    return undefined;
  }
  if (params.mentions?.length) {
    // Ingress owns these recipients. Add their markup after sanitizing model-authored
    // content, and include it in the final native envelope budget.
    card = {
      ...card,
      body: {
        ...card.body,
        elements: [
          { tag: "markdown", content: buildMentionedCardContent(params.mentions, "").trimEnd() },
          ...card.body.elements,
        ],
      },
    };
  }
  if (isNativeCard) {
    assertFeishuCardWithinEnvelope(card, "Feishu native card");
    return markRenderedFeishuCard(card);
  }
  return isFeishuCardWithinEnvelope(card) && feishuCardWithinTableLimit(card)
    ? markRenderedFeishuCard(card)
    : undefined;
}

type FeishuPresentationContext = {
  to: string;
  identity?: OutboundIdentity;
  mentions?: MentionTarget[];
  renderText?: (text: string) => string;
};

export function renderFeishuPresentationPayload({
  payload,
  presentation,
  sourcePresentation,
  ctx,
}: {
  payload: ReplyPayload;
  presentation: NormalizedMessagePresentation;
  sourcePresentation?: NormalizedMessagePresentation;
  ctx: FeishuPresentationContext;
}) {
  const card = buildFeishuPayloadCard({
    payload,
    text: payload.text,
    identity: ctx.identity,
    mentions: ctx.mentions,
    renderText: ctx.renderText,
  });
  const isComment = Boolean(parseFeishuCommentTarget(ctx.to));
  // Native limits may clip labels. A whole-card or comment fallback must retain
  // the authored labels; an accepted native card keeps its adapted projection.
  const fallbackPresentation =
    !card || isComment ? (sourcePresentation ?? presentation) : presentation;
  const { fallbackText: rawFallbackText, fallbackHasCommand } = buildFeishuPresentationFallback({
    text: readNativeFeishuCardJson(payload.text) ? undefined : payload.text,
    presentation: fallbackPresentation,
    textFormat: isComment ? "plain" : "markdown",
  });
  // Card elements and the fallback are separate projections of authored prose.
  // Neither projection consumes text already formatted for the other.
  const fallbackText = ctx.renderText ? ctx.renderText(rawFallbackText) : rawFallbackText;
  const existingFeishuData = isRecord(payload.channelData?.feishu)
    ? payload.channelData.feishu
    : undefined;
  if (!card) {
    // Core strips presentation from this post-queue transport copy. Preserve its
    // own visible contribution separately from prose already delivered by streaming.
    return {
      ...payload,
      text: fallbackText,
      channelData: {
        ...payload.channelData,
        feishu: {
          ...existingFeishuData,
          [FEISHU_PRESENTATION_FALLBACK_MARKER]: {
            hasVisibleContent: Boolean(
              renderFeishuPresentationFallbackText({ presentation: fallbackPresentation }).trim(),
            ),
          },
          ...(fallbackHasCommand ? { fallbackHasCommand: true } : {}),
        },
      },
    };
  }
  // Core consumes presentation before sendPayload; carry the fallback fact.
  return {
    ...payload,
    text: fallbackText,
    channelData: {
      ...payload.channelData,
      feishu: {
        ...existingFeishuData,
        card,
        ...(fallbackHasCommand ? { fallbackHasCommand: true } : {}),
      },
    },
  };
}

/**
 * The shared adapter cuts an oversized block to the text limit before the plugin renders
 * anything, and that cut lands on the authored table, so every fragment after the first
 * starts on a data row and no longer parses as a table at all. Projecting here, and
 * cutting the projected form with the chunker that closes and reopens a fence, hands the
 * adapter blocks that already fit and that it therefore leaves alone.
 */
function projectPresentationBlocks(
  presentation: NormalizedMessagePresentation,
  renderText: (text: string) => string,
): NormalizedMessagePresentation {
  const blocks: MessagePresentationBlock[] = [];
  for (const block of presentation.blocks) {
    if (block.type !== "text" && block.type !== "context") {
      blocks.push(block);
      continue;
    }
    const reserve = block.type === "context" ? FEISHU_CARD_GREY_LENGTH : 0;
    const parts = projectBlockText(block.text, renderText, reserve);
    if (parts.length <= 1 && parts[0] === block.text) {
      blocks.push(block);
      continue;
    }
    for (const text of parts) {
      blocks.push({ ...block, text });
    }
  }
  return { ...presentation, blocks };
}

/**
 * Core adapts a presentation to this channel's limits before the plugin renders anything, and
 * the registered outbound path reaches the renderer with that cut already made. Projecting the
 * source and adapting the projection hands the same adapter blocks that already fit, so it
 * leaves them whole. A projection that changes nothing leaves core's own adaptation standing.
 */
export function projectPresentationForDelivery(params: {
  presentation: NormalizedMessagePresentation;
  sourcePresentation?: NormalizedMessagePresentation;
  renderText?: (text: string) => string;
}): NormalizedMessagePresentation {
  const { presentation, sourcePresentation, renderText } = params;
  if (!renderText || !sourcePresentation) {
    return presentation;
  }
  const projected = projectPresentationBlocks(sourcePresentation, renderText);
  const unchanged =
    projected.blocks.length === sourcePresentation.blocks.length &&
    projected.blocks.every((block, index) => block === sourcePresentation.blocks[index]);
  if (unchanged) {
    return presentation;
  }
  return (
    normalizeMessagePresentation(
      adaptMessagePresentationForChannel({
        presentation: projected,
        capabilities: FEISHU_PRESENTATION_CAPABILITIES,
      }),
    ) ?? presentation
  );
}

export async function renderFeishuReplyPayload(
  payload: ReplyPayload,
  ctx: FeishuPresentationContext,
): Promise<{ payload: ReplyPayload; card?: FeishuNativeCard }> {
  const { presentation } = resolveFeishuRichReply(payload);
  if (!presentation) {
    return {
      payload:
        payload.text && ctx.renderText
          ? { ...payload, text: ctx.renderText(payload.text) }
          : payload,
    };
  }
  const rendered = await renderPresentationForDelivery(
    {
      presentationCapabilities: FEISHU_PRESENTATION_CAPABILITIES,
      renderPresentation: (adapted, sourcePresentation) =>
        renderFeishuPresentationPayload({
          payload: adapted,
          presentation: adapted.presentation,
          sourcePresentation,
          ctx,
        }),
    },
    {
      ...payload,
      presentation: ctx.renderText
        ? projectPresentationBlocks(presentation, ctx.renderText)
        : presentation,
    },
  );
  // Legacy controls have now been consumed too; a fallback must not render them again.
  const { interactive: _interactive, ...withoutInteractive } = rendered;
  return { payload: withoutInteractive, card: readNativeFeishuCard(withoutInteractive) };
}
