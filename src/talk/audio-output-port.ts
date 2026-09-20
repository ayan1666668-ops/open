import type { MessagePort } from "node:worker_threads";
import { createRealtimeVoiceAudioQueue } from "./realtime-session-lifecycle.js";

/** A call-bound mono PCM16/24kHz sink. Transfer port; share state, never transfer it.
 * The first Int32 is a close fence: zero permits audio, one permanently revokes it.
 * The receiver checks it before playback and acknowledges each accepted audio message.
 */
export type RealtimeVoiceAudioOutputPort = { port: MessagePort; state: SharedArrayBuffer };
export type RealtimeVoiceAudioOutputMessage =
  | { type: "audio"; audio: Uint8Array }
  | { type: "clear" };

/** Keeps continuous media off the control event loop with one outstanding PCM message. */
export function createRealtimeVoiceAudioPortSender(output: RealtimeVoiceAudioOutputPort) {
  const fence = new Int32Array(output.state, 0, 1);
  const queue = createRealtimeVoiceAudioQueue("drop-oldest");
  let closed = false;
  let inFlight = false;
  const live = () => !closed && Atomics.load(fence, 0) === 0;
  const flush = () => {
    if (!live() || inFlight) {
      return;
    }
    const audio = queue.dequeue();
    if (!audio) {
      return;
    }
    // Never transfer Buffer pool storage or detach a view retained by a caller.
    const bytes = new Uint8Array(audio.length);
    bytes.set(audio);
    inFlight = true;
    output.port.postMessage(
      { type: "audio", audio: bytes } satisfies RealtimeVoiceAudioOutputMessage,
      [bytes.buffer],
    );
  };
  const acknowledge = (message: { type: "ack" }) => {
    if (message.type !== "ack" || !live()) {
      return;
    }
    inFlight = false;
    flush();
  };
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    Atomics.store(fence, 0, 1);
    queue.clear();
    output.port.off("message", acknowledge);
    output.port.off("close", close);
    output.port.close();
  };
  output.port.on("message", acknowledge);
  output.port.on("close", close);
  return {
    sendAudio(audio: Buffer): void {
      if (!live()) {
        return;
      }
      queue.enqueue(audio);
      flush();
    },
    clear(): void {
      if (!live()) {
        return;
      }
      queue.clear();
      // The same port orders interruption after old PCM and before new PCM.
      output.port.postMessage({ type: "clear" } satisfies RealtimeVoiceAudioOutputMessage, []);
    },
    close,
  };
}
