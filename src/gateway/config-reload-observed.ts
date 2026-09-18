import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";

export type ConfigReloadObservation = Readonly<{
  generation: number;
  sourceConfig: OpenClawConfig | null;
}>;

// The reloader owns config-source reads. Publish one immutable record so health
// cannot combine a generation from one transaction with source from another.
let configReloadObservation: ConfigReloadObservation = {
  generation: 0,
  sourceConfig: null,
};

export function publishReloadObservation(sourceConfig: OpenClawConfig | null): void {
  configReloadObservation = {
    generation: configReloadObservation.generation + 1,
    sourceConfig,
  };
}

export function getConfigReloadObservation(): ConfigReloadObservation {
  return configReloadObservation;
}

/**
 * Holds one reloader transaction's source read until the transaction finishes.
 * Publishing then, and only while its epoch is current, lets health compare the
 * exact accepted or rejected candidate; a newer write revokes it before it escapes.
 */
export function trackReloadObservation(isCurrent: (epoch: number) => boolean) {
  let candidate: { epoch: number; sourceConfig: OpenClawConfig | null } | null = null;
  return {
    observe(epoch: number, sourceConfig: OpenClawConfig | null) {
      candidate = { epoch, sourceConfig };
    },
    observeSnapshot(
      epoch: number,
      snapshot: Pick<ConfigFileSnapshot, "exists" | "valid" | "sourceConfig">,
    ) {
      candidate = {
        epoch,
        sourceConfig: snapshot.exists && snapshot.valid ? snapshot.sourceConfig : null,
      };
    },
    publishIfCurrent() {
      if (candidate && isCurrent(candidate.epoch)) {
        publishReloadObservation(candidate.sourceConfig);
      }
    },
  };
}
