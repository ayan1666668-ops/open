import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, readConfigFileSnapshot } from "../config/config.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { fixture, modelRef, tempDirs } from "./setup-inference-activate.test-support.js";

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
  clearConfigCache();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("configured utility detection and activation", () => {
  it.each(["helper", modelRef])(
    "rechecks the advertised canonical identity while preserving authored %s and its profile",
    async (authoredModel) => {
      const setup = await fixture({ modelTarget: "utility" });
      const activated = await setup.activate();
      expect(activated, await setup.diagnostics(activated)).toMatchObject({ ok: true });
      const profile = setup.readProfile();
      assert(profile);
      const config = (await readConfigFileSnapshot()).sourceConfig;
      const defaults = config.agents?.defaults;
      assert(defaults?.models?.[modelRef]);
      defaults.models[modelRef].alias = "helper";
      defaults.utilityModel = `${authoredModel}@${profile[0]}`;
      const authoredConfig = `${JSON.stringify(config, null, 2)}\n`;
      await fs.writeFile(setup.configPath, authoredConfig);
      clearConfigCache();

      const detected = await setup.detect();
      expect(detected).toMatchObject({
        utilityModel: modelRef,
        setupModel: modelRef,
        setupComplete: false,
      });
      expect(detected.configuredModel).toBeUndefined();
      const candidate = detected.candidates.find(
        (entry) => entry.kind === "existing-model" && entry.modelTarget === "utility",
      );
      assert(candidate);
      expect(candidate.modelRef).toBe(modelRef);
      setup.run.mockClear();
      const verified = await setup.activate("existing-model", undefined, {
        modelRef: candidate.modelRef,
        modelTarget: candidate.modelTarget,
      });
      expect(verified, await setup.diagnostics(verified)).toMatchObject({
        ok: true,
        modelRef,
        modelTarget: "utility",
      });
      expect(setup.run).toHaveBeenCalledOnce();
      expect(setup.run.mock.calls[0]?.[0].authProfileId).toBe(profile[0]);
      expect(await fs.readFile(setup.configPath, "utf8")).toBe(authoredConfig);
    },
  );
});
