import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import type { DevicePlacementOption } from "./device-placement.ts";
import type { DraftCloudProfile } from "./discovery.ts";
import type { NewSessionWhere } from "./preferences.ts";

registerNewSessionSetupEnglish();

type DestinationSnapshot = {
  locked: boolean;
  nativeTerminal: boolean;
  isAdmin: boolean;
  connected: boolean;
  catalogReady: boolean;
  catalogDisabledReason?: string;
  nodeToolsSupported: boolean;
  devices: () => readonly DevicePlacementOption[];
  cloudProfiles: readonly DraftCloudProfile[];
  cloudRuntimeUnsupported: (profile: DraftCloudProfile) => boolean;
};

/** Owns the mutually exclusive destination and its explicit or restored intent. */
export class DraftDestinationState {
  where: NewSessionWhere = { kind: "local" };
  selectedByUser = false;
  pendingPreference: NewSessionWhere | null = null;

  constructor(
    private readonly read: () => DestinationSnapshot,
    private readonly onSelected: (
      where: NewSessionWhere,
      source: "user" | "restore" | "retire-cloud",
    ) => void,
  ) {}

  get deviceId(): string {
    return this.where.kind === "device" ? this.where.id : "";
  }

  get execNode(): string {
    return this.where.kind === "node-tools" ? this.where.id : "";
  }

  get autoDevice(): boolean {
    return this.where.kind === "auto-device";
  }

  get cloudProfileId(): string {
    return this.where.kind === "cloud" ? this.where.id : "";
  }

  get remotePlacement(): boolean {
    return this.where.kind !== "local" && this.where.kind !== "node-tools";
  }

  reset() {
    this.where = { kind: "local" };
    this.selectedByUser = false;
    this.pendingPreference = null;
  }

  nodeToolsDisabledReason(deviceId: string): string | undefined {
    const snapshot = this.read();
    if (!snapshot.isAdmin) {
      return t("sessionsView.actionRequiresAdmin");
    }
    if (!snapshot.connected) {
      return t("newSession.deviceUnavailable");
    }
    if (!snapshot.nodeToolsSupported) {
      return t("newSession.nodeToolsRuntimeUnsupported");
    }
    return (
      snapshot.catalogDisabledReason ??
      (snapshot.devices().find((device) => device.deviceId === deviceId)?.nodeToolsAvailable
        ? undefined
        : t("newSession.nodeUnavailable"))
    );
  }

  select(where: NewSessionWhere) {
    const snapshot = this.read();
    if (snapshot.locked) {
      return;
    }
    if (where.kind === "node-tools") {
      if (snapshot.nativeTerminal || !where.id || this.nodeToolsDisabledReason(where.id)) {
        return;
      }
    } else if (where.kind === "device") {
      if (!snapshot.devices().some((device) => device.deviceId === where.id && device.selectable)) {
        return;
      }
    } else if (where.kind === "auto-device") {
      if (!snapshot.devices().some((device) => device.selectable)) {
        return;
      }
    } else if (where.kind === "cloud") {
      const profile = snapshot.cloudProfiles.find((candidate) => candidate.id === where.id);
      if (!snapshot.isAdmin || !profile || snapshot.cloudRuntimeUnsupported(profile)) {
        return;
      }
    }
    if (
      (where.kind === "local" || where.kind === "device" || where.kind === "auto-device") &&
      where.kind === this.where.kind &&
      (where.kind !== "device" || where.id === this.deviceId)
    ) {
      return;
    }
    this.where = where;
    this.selectedByUser = true;
    this.pendingPreference = null;
    this.onSelected(where, "user");
  }

  restore(): boolean {
    const preferred = this.selectedByUser ? null : this.pendingPreference;
    const snapshot = this.read();
    if (!preferred || !snapshot.catalogReady) {
      return false;
    }
    let retiredCloud = false;
    if (preferred.kind === "cloud") {
      const profile = snapshot.cloudProfiles.find((candidate) => candidate.id === preferred.id);
      retiredCloud = !snapshot.isAdmin || !profile || snapshot.cloudRuntimeUnsupported(profile);
    }
    // Device intent survives unavailable hardware, lost access, and incompatible model changes.
    // Submission reports the current reason instead of silently sending the draft to the Gateway.
    this.where = retiredCloud ? { kind: "local" } : preferred;
    this.pendingPreference = null;
    this.onSelected(this.where, retiredCloud ? "retire-cloud" : "restore");
    return true;
  }
}
