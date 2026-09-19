import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { openPluginStateDatabase, runWriteTransaction } from "./plugin-state-store.database.js";
import {
  bindPluginStateEntry,
  getPluginStateKysely,
  upsertPluginStateEntry,
} from "./plugin-state-store.kernel.js";
import { optionPolicy } from "./plugin-state-store.validation.js";
import "./plugin-state-store.sqlite.js";

type PluginStateSeedEntry = {
  pluginId: string;
  namespace: string;
  key: string;
  value: unknown;
  createdAt?: number;
  expiresAt?: number | null;
};

export function clearPluginStateStoreForTests(): void {
  const { db } = openPluginStateDatabase("clear");
  executeSqliteQuerySync(db, getPluginStateKysely(db).deleteFrom("plugin_state_entries"));
  optionPolicy.clear();
}

export function setMaxPluginStateEntriesPerPluginForTests(value?: number): void {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.pluginStateSqliteTestApi")
  ] as { setMaxPluginStateEntriesPerPluginForTests(value?: number): void };
  api.setMaxPluginStateEntriesPerPluginForTests(value);
}

/** Seeds plugin state entries for tests without opening public store handles. */
export function seedPluginStateEntriesForTests(entries: PluginStateSeedEntry[]): void {
  if (entries.length === 0) {
    return;
  }
  const rows = entries.map(({ value, ...entry }) => {
    const valueJson = JSON.stringify(value);
    if (valueJson == null) {
      throw new Error("plugin state seed value must be JSON serializable");
    }
    return { ...entry, valueJson };
  });
  const now = Date.now();
  runWriteTransaction("register", ({ db }) => {
    for (const [index, entry] of rows.entries()) {
      upsertPluginStateEntry(
        db,
        bindPluginStateEntry({
          ...entry,
          createdAt: entry.createdAt ?? now + index,
          expiresAt: entry.expiresAt ?? null,
        }),
      );
    }
  });
}
