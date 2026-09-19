// Covers prefix recovery refusing to replace live bytes without a forensic copy.
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createConfigIO } from "./io.factory.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

function formatConfig(config: unknown): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

describe("prefixed config recovery", () => {
  it("leaves the live file unchanged when the forensic copy cannot be written", async () => {
    const home = tempDirs.make("openclaw-prefix-recovery-clobber-lock-");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const cleanRaw = formatConfig({ gateway: { mode: "local" } });
    const pollutedRaw = `Found and updated: False\n${cleanRaw}`;
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, pollutedRaw, "utf-8");
    await fsp.mkdir(`${configPath}.clobber.lock`, { mode: 0o700 });

    const warn = vi.fn();
    const io = createConfigIO({
      configPath,
      homedir: () => home,
      observe: false,
      env: {
        HOME: home,
        USERPROFILE: home,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: home,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        VITEST: "true",
      } as NodeJS.ProcessEnv,
      logger: { warn, error: vi.fn() },
    });

    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid).toBe(false);
    await expect(io.recoverConfigFromJsonRootSuffix(snapshot)).resolves.toBe(false);
    await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(pollutedRaw);
    const lockedEntries = await fsp.readdir(path.dirname(configPath));
    expect(lockedEntries.filter((name) => name.includes(".clobbered."))).toHaveLength(0);
    const warnings = warn.mock.calls.map(([message]) => String(message)).join("\n");
    expect(warnings).toContain("Config prefix recovery skipped");
    expect(warnings).toContain("could not write the .clobbered.* copy");
    expect(warnings).not.toContain("Config auto-stripped");

    await fsp.rmdir(`${configPath}.clobber.lock`);
    const retrySnapshot = await io.readConfigFileSnapshot();
    await expect(io.recoverConfigFromJsonRootSuffix(retrySnapshot)).resolves.toBe(true);
    await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(cleanRaw);
    expect(
      (await fsp.readdir(path.dirname(configPath))).filter((name) => name.includes(".clobbered.")),
    ).toHaveLength(1);
  }, 15_000);
});
