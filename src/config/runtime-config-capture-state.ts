import type { OpenClawConfig } from "./types.openclaw.js";

export type RuntimeConfigCapture = Readonly<{
  source: OpenClawConfig;
  origin: OpenClawConfig;
  fingerprint: string;
}>;

const captures = new WeakMap<OpenClawConfig, RuntimeConfigCapture>();

export function getRuntimeConfigCapture(
  config: OpenClawConfig | undefined,
): RuntimeConfigCapture | undefined {
  return config ? captures.get(config) : undefined;
}

export function bindRuntimeConfigCapture(
  config: OpenClawConfig,
  capture: RuntimeConfigCapture,
): void {
  captures.set(config, capture);
}
