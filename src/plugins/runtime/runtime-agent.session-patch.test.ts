import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { commitSessionExecutionSelection } from "../../model-picker/apply-session-model-selection.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createRuntimeAgent } from "./runtime-agent.js";

describe("plugin runtime session patches", () => {
  it("shares the SDK public view across read and write methods without repinning canonical selection", async () => {
    await withOpenClawTestState({ label: "plugin-runtime-public-session-view" }, async () => {
      const runtime = createRuntimeAgent();
      const storePath = runtime.session.resolveStorePath(undefined, { agentId: "main" });
      const scope = { agentId: "main", sessionKey: "agent:main:qa-session", storePath };
      const canonical: InternalSessionEntry = {
        sessionId: "qa-session",
        updatedAt: 100,
        activeWriterRunId: "qa-writer",
      };
      commitSessionExecutionSelection(
        canonical,
        {
          executor: { kind: "harness", id: "openclaw" },
          model: { provider: "qa-provider", id: "qa-model" },
        },
        { cause: { kind: "initialize" } },
      );
      await replaceSessionEntry(scope, canonical);
      const assertPublicView = (
        entry: ReturnType<typeof runtime.session.getSessionEntry> | null,
      ) => {
        expect(entry).toMatchObject({
          executionSelection: canonical.executionSelection,
          agentRuntimeOverride: "openclaw",
        });
        expect(entry).not.toHaveProperty("providerOverride");
        expect(entry).not.toHaveProperty("modelOverride");
        expect(entry).not.toHaveProperty("activeWriterRunId");
      };
      assertPublicView(runtime.session.getSessionEntry(scope));
      assertPublicView(
        runtime.session.listSessionEntries({ agentId: "main", storePath })[0]?.entry,
      );
      assertPublicView(
        await runtime.session.patchSessionEntry({
          ...scope,
          preserveActivity: true,
          update: (entry, { existingEntry }) => {
            assertPublicView(entry);
            assertPublicView(existingEntry);
            return { displayName: "Patched title" };
          },
        }),
      );
      const updated = await runtime.session.updateSessionStoreEntry({
        storePath,
        sessionKey: scope.sessionKey,
        update: (entry) => {
          assertPublicView(entry);
          return { displayName: "Updated title" };
        },
      });
      assertPublicView(updated);
      if (!updated) {
        throw new Error("Expected the updated session");
      }
      await runtime.session.upsertSessionEntry({
        ...scope,
        entry: { ...updated, displayName: "Replaced title" },
      });
      assertPublicView(runtime.session.getSessionEntry(scope));
      expect(loadSessionEntryReadOnly(scope)).toMatchObject({
        executionSelection: canonical.executionSelection,
        activeWriterRunId: "qa-writer",
        displayName: "Replaced title",
      });
    });
  });

  it("rejects a patch whose owner closes during asynchronous preparation", async () => {
    await withOpenClawTestState({ label: "plugin-runtime-patch-owner" }, async () => {
      const runtime = createRuntimeAgent();
      const scope = { agentId: "main", sessionKey: "agent:main:reef:group:room" };
      await runtime.session.upsertSessionEntry({
        ...scope,
        entry: { sessionId: "original", updatedAt: 100, displayName: "Original title" },
      });
      const original = runtime.session.getSessionEntry(scope);
      const preparing = createDeferred();
      const releasePreparation = createDeferred();
      let ownerActive = true;
      const patch = runtime.session.patchSessionEntry({
        ...scope,
        preserveActivity: true,
        assertCommitAllowed: () => {
          if (!ownerActive) {
            throw new Error("Session patch owner closed");
          }
        },
        update: async () => {
          preparing.resolve();
          await releasePreparation.promise;
          return { displayName: "Stale title" };
        },
      });
      try {
        await preparing.promise;
        ownerActive = false;
        releasePreparation.resolve();
        await expect(patch).rejects.toThrow("Session patch owner closed");
        expect(runtime.session.getSessionEntry(scope)).toEqual(original);
      } finally {
        releasePreparation.resolve();
        await patch.catch(() => undefined);
      }
    });
  });
});
