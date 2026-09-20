import type {
  RealtimeVoiceAudioOutputPort,
  RealtimeVoiceBridgeCreateRequest,
} from "openclaw/plugin-sdk/realtime-voice";
import type {
  OpenAIQuicksilverSocket,
  OpenAIQuicksilverSocketFactory,
} from "./realtime-quicksilver-sideband.js";

export const QUICKSILVER_SOCKET_CONTROL_LIMIT = 128;
export const QUICKSILVER_SOCKET_CONTROL_BYTES = 1024 * 1024;
export const QUICKSILVER_SOCKET_AUDIO_BYTES = 240_000;
export const QUICKSILVER_SOCKET_AUDIO_BATCH_BYTES = 9_600;

export type QuicksilverSocketMediaOptions = {
  model: string;
  paced: boolean;
  audioFormat?: RealtimeVoiceBridgeCreateRequest["audioFormat"];
};
export type QuicksilverSocketCallbacks = {
  onAudio(audio: Buffer): void;
};
export type QuicksilverMediaSocket = OpenAIQuicksilverSocket & {
  sendAudio(audio: Buffer): void;
  setAudioOutputPort(output: RealtimeVoiceAudioOutputPort): void;
  startAudio(): void;
  stopAudio(): void;
};
export type QuicksilverMediaSocketFactory = (
  url: string,
  options: Parameters<OpenAIQuicksilverSocketFactory>[1],
  media: QuicksilverSocketMediaOptions,
  callbacks: QuicksilverSocketCallbacks,
) => QuicksilverMediaSocket;

export type QuicksilverSocketCommand =
  | { type: "send"; payload: string }
  | { type: "audio"; audio: Uint8Array }
  | { type: "audio-output"; output: RealtimeVoiceAudioOutputPort }
  | { type: "start-audio" }
  | { type: "stop-audio" }
  | { type: "event-ack" }
  | { type: "close"; code: number; reason: string };
export type QuicksilverSocketEvent =
  | { type: "open" }
  | { type: "frame"; data: Uint8Array; isBinary: boolean }
  | { type: "audio"; audio: Uint8Array }
  | { type: "error" }
  | { type: "close"; code: number; reason: string };
export type QuicksilverSocketMessage =
  | QuicksilverSocketEvent
  | { type: "input-ack" }
  | { type: "send-ack" };
export type QuicksilverSocketWorkerData = QuicksilverSocketMediaOptions & {
  url: string;
  options: Parameters<OpenAIQuicksilverSocketFactory>[1];
};

/** Bounded raw-byte tail: unlike PCM queues this must retain odd-length mu-law chunks. */
export class QuicksilverSocketAudioQueue {
  private storage: Buffer | undefined;
  private offset = 0;
  private bytes = 0;
  constructor(private readonly limit = QUICKSILVER_SOCKET_AUDIO_BYTES) {}
  get length(): number {
    return this.bytes;
  }
  append(audio: Buffer): void {
    const count = Math.min(audio.length, this.limit);
    if (!count) {
      return;
    }
    const storage = (this.storage ??= Buffer.alloc(this.limit));
    const dropped = Math.max(0, this.bytes + count - this.limit);
    this.offset = (this.offset + dropped) % this.limit;
    this.bytes -= dropped;
    const writeAt = (this.offset + this.bytes) % this.limit;
    const first = Math.min(count, this.limit - writeAt);
    const sourceAt = audio.length - count;
    audio.copy(storage, writeAt, sourceAt, sourceAt + first);
    if (first < count) {
      audio.copy(storage, 0, sourceAt + first);
    }
    this.bytes += count;
  }
  take(limit = this.bytes): Buffer {
    const output = Buffer.alloc(Math.min(limit, this.bytes));
    if (output.length && this.storage) {
      const first = Math.min(output.length, this.limit - this.offset);
      this.storage.copy(output, 0, this.offset, this.offset + first);
      if (first < output.length) {
        this.storage.copy(output, first, 0, output.length - first);
      }
      this.offset = (this.offset + output.length) % this.limit;
      this.bytes -= output.length;
    }
    return output;
  }
  clear(): void {
    this.storage = undefined;
    this.offset = 0;
    this.bytes = 0;
  }
}
