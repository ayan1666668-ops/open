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
const CODEX_LOCAL_AUDIO_EXTENSIONS = new Set([".m4a", ".mp3", ".ogg", ".wav", ".webm"]);

export type CodexConversationAudioMedia = {
  filePath: string;
  mediaUrl?: string;
  mime?: string;
  workspaceDir?: string;
};

export function buildCodexConversationTurnInput(params: {
  prompt: string;
  event: PluginHookInboundClaimEvent;
}): CodexUserInput[] {
  return [
    { type: "text", text: params.prompt, text_elements: [] },
    ...(params.event.media ?? [])
      .map(toCodexMediaInput)
      .filter((item): item is CodexUserInput => item !== undefined),
  ];
}

export function hasCodexConversationTurnMedia(event: PluginHookInboundClaimEvent): boolean {
  return (event.media ?? []).some((media) => isImageMedia(media) || isAudioMedia(media));
}

export function listCodexConversationAudioForTranscription(
  event: PluginHookInboundClaimEvent,
): CodexConversationAudioMedia[] {
  const media = event.media ?? [];
  const audioCount = media.filter(isAudioMedia).length;
  const transcriptCoversSingleAudio = audioCount === 1 && Boolean(event.transcript?.trim());
  return media.flatMap((entry) => {
    if (!isAudioMedia(entry) || entry.transcribed === true || transcriptCoversSingleAudio) {
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
        filePath,
        ...(!normalizedLocalPath && remoteMediaUrl ? { mediaUrl: remoteMediaUrl } : {}),
        ...(entry.contentType ? { mime: entry.contentType } : {}),
        ...(entry.workspaceDir ? { workspaceDir: entry.workspaceDir } : {}),
      },
    ];
  });
}

function toCodexMediaInput(media: PluginHookMediaFact): CodexUserInput | undefined {
  const localPath = media.path ?? readLocalMediaPath(media.url);
  if (localPath) {
    const normalized = normalizeFileUrl(localPath);
    if (!normalized) {
      return undefined;
    }
    if (isImageMedia(media)) {
      return { type: "localImage", path: normalized };
    }
    if (isAudioMedia(media) && isCodexLocalAudioPath(normalized)) {
      return { type: "localAudio", path: normalized };
    }
    return undefined;
  }
  if (isImageMedia(media)) {
    return media.url ? { type: "image", url: media.url } : undefined;
  }
  if (isAudioMedia(media) && media.url?.toLowerCase().startsWith("data:audio/")) {
    return { type: "audio", url: media.url };
  }
  return undefined;
}

function isImageMedia(media: PluginHookMediaFact): boolean {
  if (media.kind === "image" || media.contentType?.toLowerCase().startsWith("image/")) {
    return true;
  }
  const candidate = media.path ?? media.url;
  if (!candidate) {
    return false;
  }
  return IMAGE_EXTENSIONS.has(path.extname(candidate.split(/[?#]/, 1)[0] ?? "").toLowerCase());
}

function isAudioMedia(media: PluginHookMediaFact): boolean {
  const mimeType = media.contentType?.toLowerCase();
  if (
    media.kind?.toLowerCase() === "audio" ||
    mimeType === "audio" ||
    mimeType?.startsWith("audio/")
  ) {
    return true;
  }
  const candidate = media.path ?? media.url;
  if (!candidate) {
    return false;
  }
  return AUDIO_EXTENSIONS.has(path.extname(candidate.split(/[?#]/, 1)[0] ?? "").toLowerCase());
}

function isCodexLocalAudioPath(value: string): boolean {
  return CODEX_LOCAL_AUDIO_EXTENSIONS.has(path.extname(value).toLowerCase());
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
