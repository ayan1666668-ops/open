type AudioInputBudgetStatusCallback = (status: "error" | "listening", detail: string) => void;

const MAX_PENDING_AUDIO_MS = 3_000;

export class RealtimeTalkAudioInputBudget {
  private pendingMs = 0;
  private lossReported = false;

  constructor(private readonly onStatus: AudioInputBudgetStatusCallback) {}

  reserve(frameMs: number): boolean {
    if (this.pendingMs + frameMs <= MAX_PENDING_AUDIO_MS) {
      this.pendingMs += frameMs;
      return true;
    }
    if (!this.lossReported) {
      this.lossReported = true;
      this.onStatus("error", "Realtime Talk audio input fell behind; repeat the last part");
    }
    return false;
  }

  settle(frameMs: number): void {
    this.pendingMs = Math.max(0, this.pendingMs - frameMs);
    if (this.lossReported) {
      this.lossReported = false;
      this.onStatus("listening", "Microphone input recovered; repeat the last part");
    }
  }

  reset(): void {
    this.pendingMs = 0;
    this.lossReported = false;
  }
}
