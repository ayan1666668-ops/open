// OpenClaw-authored rich block subset plus size accounting and the plain-text
// projection shared by the emitter, splitter, and fallback paths.
export type TelegramRichBlocksDegradationReason = "list-limit" | "table-ascii";

export type RichText =
  | string
  | RichText[]
  | {
      type:
        | "bold"
        | "italic"
        | "underline"
        | "strikethrough"
        | "code"
        | "spoiler"
        | "marked"
        | "subscript"
        | "superscript";
      text: RichText;
    }
  | {
      type: "url";
      text: RichText;
      url: string;
    }
  | {
      type: "anchor_link";
      text: RichText;
      anchor_name: string;
    }
  | {
      type: "mathematical_expression";
      expression: string;
    }
  | {
      type: "custom_emoji";
      custom_emoji_id: string;
      alternative_text: string;
    };

type RichBlockTableCellAlign = "left" | "center" | "right";

export type RichBlockTableCell = {
  text?: RichText;
  is_header?: true;
  colspan?: number;
  rowspan?: number;
  align: RichBlockTableCellAlign;
  valign: "top" | "middle" | "bottom";
};

export type InputRichBlockParagraph = {
  type: "paragraph";
  text: RichText;
};

type InputRichBlockHeading = {
  type: "heading";
  text: RichText;
  size: 1 | 2 | 3 | 4 | 5 | 6;
};

type InputRichBlockPre = {
  type: "pre";
  text: string;
  language?: string;
};

type InputRichBlockBlockquote = {
  type: "blockquote";
  blocks: InputRichBlock[];
  credit?: RichText;
};

type InputRichBlockTable = {
  type: "table";
  cells: RichBlockTableCell[][];
  is_bordered?: true;
  is_striped?: true;
  caption?: RichText;
};

export type RichBlockCaption = {
  text: RichText;
  credit?: RichText;
};

export type InputRichBlockListItem = {
  blocks: InputRichBlock[];
  has_checkbox?: true;
  is_checked?: true;
  value?: number;
  type?: "a" | "A" | "i" | "I" | "1";
};

type InputMediaUrl<K extends string> = { type: K; media: string };

export type InputRichBlock =
  | InputRichBlockParagraph
  | InputRichBlockHeading
  | InputRichBlockPre
  | InputRichBlockBlockquote
  | InputRichBlockTable
  | { type: "divider" }
  | { type: "anchor"; name: string }
  | { type: "footer"; text: RichText }
  | { type: "pullquote"; text: RichText; credit?: RichText }
  | { type: "mathematical_expression"; expression: string }
  | { type: "details"; summary: RichText; blocks: InputRichBlock[]; is_open?: true }
  | { type: "list"; items: InputRichBlockListItem[] }
  | { type: "photo"; photo: InputMediaUrl<"photo">; caption?: RichBlockCaption }
  | { type: "video"; video: InputMediaUrl<"video">; caption?: RichBlockCaption }
  | { type: "audio"; audio: InputMediaUrl<"audio">; caption?: RichBlockCaption }
  | { type: "animation"; animation: InputMediaUrl<"animation">; caption?: RichBlockCaption }
  | { type: "voice_note"; voice_note: InputMediaUrl<"voice_note">; caption?: RichBlockCaption }
  | { type: "collage"; blocks: InputRichBlock[]; caption?: RichBlockCaption }
  | { type: "slideshow"; blocks: InputRichBlock[]; caption?: RichBlockCaption }
  | {
      type: "map";
      location: { latitude: number; longitude: number };
      zoom: number;
      width: number;
      height: number;
      caption?: RichBlockCaption;
    };

export function normalizeRichText(value: RichText): RichText {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const flattened: RichText[] = [];
    for (const item of value) {
      const normalized = normalizeRichText(item);
      if (normalized === "") {
        continue;
      }
      if (Array.isArray(normalized)) {
        flattened.push(...normalized);
      } else {
        flattened.push(normalized);
      }
    }
    if (flattened.length === 0) {
      return "";
    }
    if (flattened.length === 1) {
      return flattened[0] ?? "";
    }
    return flattened;
  }
  if (value.type === "mathematical_expression" || value.type === "custom_emoji") {
    return value;
  }
  return { ...value, text: normalizeRichText(value.text) };
}

export function countRichTextChars(text: RichText): number {
  if (typeof text === "string") {
    return text.length;
  }
  if (Array.isArray(text)) {
    return text.reduce((total, part) => total + countRichTextChars(part), 0);
  }
  if (text.type === "mathematical_expression") {
    return text.expression.length;
  }
  if (text.type === "custom_emoji") {
    return text.alternative_text.length;
  }
  return countRichTextChars(text.text);
}

/** Bot API budgets: UTF-16 text, nested blocks/items/rows, media, and formatting edges. */
export function measureInputRichBlocks(blocks: readonly InputRichBlock[]) {
  const size = { chars: 0, blocks: 0, media: 0, nesting: 0 };
  const visitText = (text: RichText, depth: number): void => {
    size.nesting = Math.max(size.nesting, depth);
    if (typeof text === "string") {
      size.chars += text.length;
    } else if (Array.isArray(text)) {
      for (const part of text) {
        visitText(part, depth);
      }
    } else if (text.type === "mathematical_expression") {
      size.chars += text.expression.length;
    } else if (text.type === "custom_emoji") {
      size.chars += text.alternative_text.length;
    } else {
      visitText(text.text, depth + 1);
    }
  };
  const visitCaption = (caption: RichBlockCaption | undefined, depth: number) => {
    if (caption) {
      visitText(caption.text, depth);
      visitText(caption.credit ?? "", depth);
    }
  };
  const visitBlocks = (children: readonly InputRichBlock[], depth: number): void => {
    size.nesting = Math.max(size.nesting, depth);
    for (const block of children) {
      size.blocks += 1;
      switch (block.type) {
        case "paragraph":
        case "heading":
        case "footer":
        case "pre":
          visitText(block.text, depth);
          break;
        case "mathematical_expression":
          visitText(block.expression, depth);
          break;
        case "pullquote":
          visitText(block.text, depth);
          visitText(block.credit ?? "", depth);
          break;
        case "blockquote":
          visitBlocks(block.blocks, depth + 1);
          visitText(block.credit ?? "", depth + 1);
          break;
        case "details":
          visitBlocks(block.blocks, depth + 1);
          visitText(block.summary, depth + 1);
          break;
        case "collage":
        case "slideshow":
          visitBlocks(block.blocks, depth + 1);
          visitCaption(block.caption, depth + 1);
          break;
        case "list":
          size.blocks += block.items.length;
          size.nesting = Math.max(size.nesting, depth + 1);
          for (const item of block.items) {
            visitBlocks(item.blocks, depth + 1);
          }
          break;
        case "table":
          size.blocks += block.cells.length;
          visitText(block.caption ?? "", depth + 1);
          for (const row of block.cells) {
            for (const cell of row) {
              visitText(cell.text ?? "", depth + 1);
            }
          }
          break;
        case "photo":
        case "video":
        case "audio":
        case "animation":
        case "voice_note":
          size.media += 1;
          visitCaption(block.caption, depth + 1);
          break;
        case "map":
          // Live-verified: maps do not consume the 50-attachment budget.
          visitCaption(block.caption, depth + 1);
          break;
      }
    }
  };
  visitBlocks(blocks, 0);
  return size;
}

export function richTextToPlainString(text: RichText): string {
  if (typeof text === "string") {
    return text;
  }
  if (Array.isArray(text)) {
    return text.map(richTextToPlainString).join("");
  }
  if (text.type === "mathematical_expression") {
    return text.expression;
  }
  if (text.type === "custom_emoji") {
    return text.alternative_text;
  }
  return richTextToPlainString(text.text);
}

function captionToPlainText(caption: RichBlockCaption | undefined): string {
  if (!caption) {
    return "";
  }
  const credit = caption.credit ? ` — ${richTextToPlainString(caption.credit)}` : "";
  return `${richTextToPlainString(caption.text)}${credit}`.trim();
}

function inputRichBlocksToPlainTextAtDepth(
  blocks: readonly InputRichBlock[],
  listDepth: number,
): string {
  const parts: string[] = [];
  const push = (value: string) => {
    if (value) {
      parts.push(value);
    }
  };
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
      case "heading":
      case "footer":
        push(richTextToPlainString(block.text));
        break;
      case "pre":
        push(block.text);
        break;
      case "mathematical_expression":
        push(block.expression);
        break;
      case "pullquote":
        push(
          block.credit
            ? `${richTextToPlainString(block.text)} — ${richTextToPlainString(block.credit)}`
            : richTextToPlainString(block.text),
        );
        break;
      case "blockquote":
        push(inputRichBlocksToPlainTextAtDepth(block.blocks, listDepth));
        if (block.credit) {
          push(`— ${richTextToPlainString(block.credit)}`);
        }
        break;
      case "collage":
      case "slideshow":
        push(inputRichBlocksToPlainTextAtDepth(block.blocks, listDepth));
        push(captionToPlainText(block.caption));
        break;
      case "details":
        push(richTextToPlainString(block.summary));
        push(inputRichBlocksToPlainTextAtDepth(block.blocks, listDepth));
        break;
      case "list":
        for (const item of block.items) {
          const markerText = item.has_checkbox
            ? item.is_checked
              ? "[x] "
              : "[ ] "
            : item.value !== undefined
              ? `${item.value}. `
              : "• ";
          const marker = `${"  ".repeat(listDepth)}${markerText}`;
          push(`${marker}${inputRichBlocksToPlainTextAtDepth(item.blocks, listDepth + 1)}`);
        }
        break;
      case "table":
        if (block.caption !== undefined) {
          push(richTextToPlainString(block.caption));
        }
        for (const row of block.cells) {
          push(row.map((cell) => richTextToPlainString(cell.text ?? "")).join(" | "));
        }
        break;
      // Fallback text keeps BOTH caption and source so a degraded delivery
      // still lets the user reach the media.
      case "photo":
        push(`${captionToPlainText(block.caption)} ${block.photo.media}`.trim());
        break;
      case "video":
        push(`${captionToPlainText(block.caption)} ${block.video.media}`.trim());
        break;
      case "audio":
        push(`${captionToPlainText(block.caption)} ${block.audio.media}`.trim());
        break;
      case "animation":
        push(`${captionToPlainText(block.caption)} ${block.animation.media}`.trim());
        break;
      case "voice_note":
        push(`${captionToPlainText(block.caption)} ${block.voice_note.media}`.trim());
        break;
      case "map":
        push(
          `${captionToPlainText(block.caption)} ${block.location.latitude},${block.location.longitude}`.trim(),
        );
        break;
      case "divider":
      case "anchor":
        break;
    }
  }
  return parts.join("\n");
}

export function inputRichBlocksToPlainText(blocks: readonly InputRichBlock[]): string {
  return inputRichBlocksToPlainTextAtDepth(blocks, 0);
}

export function boldRichText(text: string): RichText {
  return { type: "bold", text };
}

export function italicRichText(text: string): RichText {
  return { type: "italic", text };
}

export function paragraphBlock(text: RichText): InputRichBlockParagraph {
  return { type: "paragraph", text };
}
