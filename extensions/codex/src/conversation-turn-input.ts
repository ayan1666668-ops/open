import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  PluginHookInboundClaimEvent,
  PluginHookMediaFact,
} from "openclaw/plugin-sdk/plugin-entry";
import type { CodexUserInput } from "./app-server/protocol.js";

const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".alac",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".webm",
  ".wma",
]);
export type CodexConversationAudioAttachment = {
  path?: string;
  url?: string;
  mime?: string;
  kind?: "image" | "audio" | "video" | "document" | "sticker" | "unknown";
  workspaceDir?: string;
  index: number;
  alreadyTranscribed?: boolean;
};

export function buildCodexConversationTurnInput(params: {
  prompt: string;
  event: PluginHookInboundClaimEvent;
}): CodexUserInput[] {
  return [
    { type: "text", text: params.prompt, text_elements: [] },
    ...(params.event.media ?? [])
      .map(toCodexImageInput)
      .filter((item): item is CodexUserInput => item !== undefined),
  ];
}

export function hasCodexConversationTurnMedia(event: PluginHookInboundClaimEvent): boolean {
  return (event.media ?? []).some((media) => isImageMedia(media) || isAudioMedia(media));
}

export function hasUsableCodexConversationTurnInput(params: {
  prompt: string;
  event: PluginHookInboundClaimEvent;
}): boolean {
  return buildCodexConversationTurnInput(params).some(
    (input) => input.type !== "text" || Boolean(input.text.trim()),
  );
}

export function listCodexConversationAudioAttachments(
  event: PluginHookInboundClaimEvent,
): CodexConversationAudioAttachment[] {
  const media = event.media ?? [];
  const audioCount = media.filter(isAudioMedia).length;
  const transcriptCoversSingleAudio = audioCount === 1 && Boolean(event.transcript?.trim());
  return media.flatMap((entry, index) => {
    if (!isAudioMedia(entry)) {
      return [];
    }
    const localPath = entry.path ?? readLocalMediaPath(entry.url);
    const normalizedLocalPath = localPath ? normalizeFileUrl(localPath) : undefined;
    const remoteMediaUrl = entry.url && /^https?:\/\//iu.test(entry.url) ? entry.url : undefined;
    const filePath = normalizedLocalPath ?? remoteMediaUrl;
    if (!filePath) {
      return [];
    }
    return [
      {
        index,
        ...(normalizedLocalPath ? { path: normalizedLocalPath } : { url: remoteMediaUrl }),
        ...(entry.contentType ? { mime: entry.contentType } : {}),
        kind: "audio" as const,
        ...(entry.transcribed === true || transcriptCoversSingleAudio
          ? { alreadyTranscribed: true }
          : {}),
        ...(entry.workspaceDir ? { workspaceDir: entry.workspaceDir } : {}),
      },
    ];
  });
}

function toCodexImageInput(media: PluginHookMediaFact): CodexUserInput | undefined {
  const localPath = media.path ?? readLocalMediaPath(media.url);
  if (localPath) {
    const normalized = normalizeFileUrl(localPath);
    if (!normalized) {
      return undefined;
    }
    if (isImageMedia(media)) {
      return { type: "localImage", path: normalized };
    }
    return undefined;
  }
  return isImageMedia(media) && media.url ? { type: "image", url: media.url } : undefined;
}

function isImageMedia(media: PluginHookMediaFact): boolean {
  const kind = media.kind?.trim().toLowerCase();
  if (kind && kind !== "unknown") {
    return kind === "image" || kind === "sticker";
  }
  const mimeType = media.contentType?.trim().toLowerCase();
  if (mimeType) {
    if (mimeType.startsWith("image/")) {
      return true;
    }
    if (mimeType !== "application/octet-stream" && mimeType !== "binary/octet-stream") {
      return false;
    }
  }
  const candidate = media.path ?? media.url;
  if (!candidate) {
    return false;
  }
  return IMAGE_EXTENSIONS.has(path.extname(candidate.split(/[?#]/, 1)[0] ?? "").toLowerCase());
}

function isAudioMedia(media: PluginHookMediaFact): boolean {
  const kind = media.kind?.trim().toLowerCase();
  if (kind && kind !== "unknown") {
    return kind === "audio";
  }
  const mimeType = media.contentType?.trim().toLowerCase();
  if (mimeType === "audio" || mimeType?.startsWith("audio/")) {
    return true;
  }
  if (mimeType && mimeType !== "application/octet-stream" && mimeType !== "binary/octet-stream") {
    return false;
  }
  const candidate = media.path ?? media.url;
  if (!candidate) {
    return false;
  }
  return AUDIO_EXTENSIONS.has(path.extname(candidate.split(/[?#]/, 1)[0] ?? "").toLowerCase());
}

function normalizeFileUrl(value: string): string | undefined {
  if (!/^file:\/\//iu.test(value)) {
    return value;
  }
  try {
    const fileUrl = new URL(value);
    // Validate encoding explicitly because fileURLToPath validation differs by runtime.
    decodeURIComponent(fileUrl.pathname);
    return fileURLToPath(fileUrl);
  } catch {
    return undefined;
  }
}

function readLocalMediaPath(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (/^file:\/\//iu.test(value)) {
    return value;
  }
  if (value.startsWith("//")) {
    return undefined;
  }
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return value;
  }
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? undefined : value;
}
