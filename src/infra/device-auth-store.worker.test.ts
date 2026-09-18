import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { clearOpenClawStateDatabaseOpenFailure } from "../state/openclaw-state-db-cache.js";
import { withExistingOpenClawStateSchema } from "../state/openclaw-state-db-schema-policy.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import * as workerStore from "../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as tokens from "./device-auth-store.js";
import { holdDeviceAuthWriterForTest } from "./device-auth-store.test-support.js";

afterEach(() => vi.restoreAllMocks());

function observeHostSql() {
  return [
    ...(["prepare", "exec", "close"] as const).map((method) =>
      vi.spyOn(DatabaseSync.prototype, method),
    ),
    ...(["get", "all", "run", "iterate"] as const).map((method) =>
      vi.spyOn(StatementSync.prototype, method),
    ),
  ];
}

it("keeps cold, warm, read-only, ordered token operations and cleanup off the host SQLite thread", async () => {
  await withOpenClawTestState({ label: "device-token-worker" }, async (state) => {
    const lookup = { deviceId: "synthetic-device", role: "operator", env: state.env };
    const origin = { ...lookup, gatewayScope: "wss://synthetic.example/rpc" };
    const sql = observeHostSql();
    try {
      expect(await tokens.loadDeviceAuthTokenReadOnly(lookup)).toBeNull();
      expect(await tokens.loadOriginDeviceTokenReadOnly(origin)).toBeNull();
      await expect(fs.stat(state.statePath("state", "openclaw.sqlite"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const input = {
        ...lookup,
        env: { ...state.env },
        token: "synthetic-first",
        scopes: [" operator.read ", "operator.read"],
      };
      const first = tokens.storeDeviceAuthToken(input);
      input.deviceId = "changed-device";
      input.env.OPENCLAW_STATE_DIR = state.path("changed-state");
      input.scopes.push("operator.admin");
      expect(await first).toMatchObject({ token: "synthetic-first", scopes: ["operator.read"] });
      const operations = [
        tokens.storeDeviceAuthToken({
          ...lookup,
          token: "synthetic-second",
          expectedToken: "synthetic-first",
        }),
        tokens.loadDeviceAuthToken(lookup),
        tokens.clearDeviceAuthToken({ ...lookup, expectedToken: "synthetic-second" }),
        tokens.loadDeviceAuthToken(lookup),
      ];
      expect(await Promise.all(operations)).toEqual([
        expect.objectContaining({ token: "synthetic-second" }),
        expect.objectContaining({ token: "synthetic-second" }),
        true,
        null,
      ]);
      const stored = await tokens.storeOriginDeviceToken({ ...origin, token: "synthetic-origin" });
      expect(await tokens.loadOriginDeviceToken(origin)).toEqual(stored);
      expect(
        await tokens.loadOriginDeviceToken({ ...origin, gatewayScope: "wss://other.example" }),
      ).toBeNull();
      await closeOpenClawStateDatabaseAsync();
      const artifacts = (await fs.readdir(state.statePath("state"))).toSorted();
      expect(await tokens.loadOriginDeviceTokenReadOnly(origin)).toEqual(stored);
      await closeOpenClawStateDatabaseAsync();
      expect((await fs.readdir(state.statePath("state"))).toSorted()).toEqual(artifacts);
      expect(await tokens.clearOriginDeviceToken(origin)).toBe(true);
      await closeOpenClawStateDatabaseAsync();
      for (const spy of sql) {
        expect(spy).not.toHaveBeenCalled();
      }
      await expect(fs.stat(state.path("changed-state"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      sql.forEach((spy) => spy.mockRestore());
      await closeOpenClawStateDatabaseAsync();
    }
  });
});

it("rejects canceled loads, retired sources and expired schema scopes without publishing observations", async () => {
  await withOpenClawTestState({ label: "device-token-admission" }, async (state) => {
    const lookup = { deviceId: "synthetic-device", role: "operator", env: state.env };
    await tokens.storeDeviceAuthToken({ ...lookup, token: "synthetic-stored" });
    const onSnapshot = vi.fn();
    const controller = new AbortController();
    const canceled = tokens.loadDeviceAuthToken({
      ...lookup,
      onSnapshot,
      signal: controller.signal,
    });
    controller.abort(new Error("synthetic-cancel"));
    await expect(canceled).rejects.toThrow("synthetic-cancel");
    const retired = tokens.loadDeviceAuthToken({ ...lookup, onSnapshot });
    clearOpenClawStateDatabaseOpenFailure(state.statePath("state", "openclaw.sqlite"));
    await expect(retired).rejects.toThrow();
    await closeOpenClawStateDatabaseAsync();
    let expired: Promise<unknown> | undefined;
    withExistingOpenClawStateSchema({ path: state.statePath("state", "openclaw.sqlite") }, () => {
      expired = tokens.loadDeviceAuthToken({ ...lookup, onSnapshot });
    });
    assert(expired);
    await expect(expired).rejects.toThrow("admission has ended");
    expect(onSnapshot).not.toHaveBeenCalled();
  });
});

it("remains responsive and rechecks token mutation authority after waiting for a SQLite writer", async () => {
  await withOpenClawTestState({ label: "device-token-lock" }, async (state) => {
    const lookup = { deviceId: "synthetic-device", role: "operator", env: state.env };
    const stored = await tokens.storeDeviceAuthToken({ ...lookup, token: "synthetic-stored" });
    const release = await holdDeviceAuthWriterForTest(state.statePath("state", "openclaw.sqlite"));
    try {
      let current = true;
      const guard = vi.fn(() => {
        if (!current) {
          throw new Error("synthetic-owner-retired");
        }
      });
      const mutation = tokens.storeDeviceAuthToken({
        ...lookup,
        token: "synthetic-replacement",
        assertCurrent: guard,
      });
      const result = expect(mutation).rejects.toThrow("synthetic-owner-retired");
      await vi.waitFor(() => expect(guard).toHaveBeenCalled());
      await delay(20);
      current = false;
      await release();
      await result;
      expect(await tokens.loadDeviceAuthToken(lookup)).toEqual(stored);
    } finally {
      await release();
    }
  });
});

it.each(
  [false, true].flatMap((origin) => ["cancel", "retire"].map((action) => ({ origin, action }))),
)(
  "does not publish an absent worker read after $action (origin: $origin)",
  async ({ origin, action }) => {
    await withOpenClawTestState({ label: "device-token-absent-admission" }, async (state) => {
      // An existing-only open can settle without dispatching the operation callback.
      vi.spyOn(workerStore, "runOpenClawStateWorkerOperation").mockResolvedValueOnce(undefined);
      const controller = new AbortController();
      let current = true;
      const onSnapshot = vi.fn();
      const input = {
        deviceId: "synthetic-device",
        role: "operator",
        env: state.env,
        signal: controller.signal,
        assertCurrent: () => {
          if (!current) {
            throw new Error("synthetic-retired");
          }
        },
        onSnapshot,
      };
      const reading = origin
        ? tokens.loadOriginDeviceTokenReadOnly({
            ...input,
            gatewayScope: "wss://synthetic.example",
          })
        : tokens.loadDeviceAuthTokenReadOnly(input);
      if (action === "cancel") {
        controller.abort(new Error("synthetic-canceled"));
      } else {
        current = false;
      }
      await expect(reading).rejects.toThrow(
        action === "cancel" ? "synthetic-canceled" : "synthetic-retired",
      );
      expect(onSnapshot).not.toHaveBeenCalled();
    });
  },
);
