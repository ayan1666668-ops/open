import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { recordCodexEphemeralThreadCreation } from "./client-runtime.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { parseCodexNativeToolCatalog, loadCodexNativeToolCatalog } from "./native-tool-catalog.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import { isJsonObject } from "./protocol.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import { withLeasedCodexTestClient } from "./test-support.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";

const threadId = "native-thread";
const tool = {
  type: "function" as const,
  name: "example",
  description: "Synthetic tool",
  inputSchema: { type: "object" },
};

describe("parseCodexNativeToolCatalog", () => {
  it.each([{}, { dynamic_tools: null }, { dynamic_tools: [] }])(
    "restores the native empty representation %j without accepting a missing nonempty catalog",
    (catalog) => {
      const metadata = { id: threadId, ...catalog };
      expect(
        parseCodexNativeToolCatalog(metadata, threadId, codexDynamicToolsFingerprint([])),
      ).toEqual([]);
      expect(() =>
        parseCodexNativeToolCatalog(metadata, threadId, codexDynamicToolsFingerprint([tool])),
      ).toThrow("native tool catalog is missing, corrupt, or changed");
    },
  );

  it.each([
    null,
    {},
    { id: "other" },
    ...[false, 0, "", {}, [null]].map((dynamic_tools) => ({ id: threadId, dynamic_tools })),
  ])("rejects invalid metadata %j", (metadata) => {
    expect(() => parseCodexNativeToolCatalog(metadata, threadId)).toThrow(
      "native tool catalog is missing, corrupt, or changed",
    );
  });

  it("retains nonempty declarations and the pinned false-defer omission", () => {
    expect(
      parseCodexNativeToolCatalog(
        { id: threadId, dynamic_tools: [{ ...tool, deferLoading: false }] },
        threadId,
        codexDynamicToolsFingerprint([tool]),
      ),
    ).toEqual([tool]);
  });
});

describe("acknowledged ephemeral native tool catalogs", () => {
  it.each(["none", "client", "home", "runtime", "fingerprint", "missing"] as const)(
    "keeps catalog provenance checks for %s mismatch",
    async (mismatch) => {
      const agentDir = path.join(os.tmpdir(), `codex-catalog-${randomUUID()}`);
      const appServer = resolveCodexAppServerRuntimeOptions({
        pluginConfig: { appServer: { command: process.execPath, args: ["app-server"] } },
        codexConfigToml: null,
        requirementsToml: null,
      });
      const request = vi.fn(async () => ({ thread: { id: threadId, path: null } }));
      await withLeasedCodexTestClient({
        agentDir,
        request,
        run: async (client) => {
          const binding: CodexAppServerThreadBinding = {
            threadId,
            cwd: agentDir,
            clientId: client.getInstanceId(),
            connectionScope: "supervision",
            supervisionSourceThreadId: "source",
            preserveNativeModel: true,
            conversationSourceTransferComplete: true,
            dynamicToolsFingerprint: codexDynamicToolsFingerprint([tool]),
            appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(
              appServer,
              agentDir,
            ),
          };
          if (mismatch !== "missing") {
            const original = structuredClone(tool);
            recordCodexEphemeralThreadCreation(client, threadId, {
              hookInstallation: "installed",
              dynamicTools: [original],
            });
            original.inputSchema.type = "array";
          }
          if (mismatch === "client") {
            binding.clientId = "other-client";
          }
          if (mismatch === "runtime") {
            binding.appServerRuntimeFingerprint = "other-runtime";
          }
          if (mismatch === "fingerprint") {
            binding.dynamicToolsFingerprint = codexDynamicToolsFingerprint([]);
          }
          if (mismatch === "home") {
            vi.spyOn(client, "getRuntimeIdentity").mockReturnValue({
              ...client.getRuntimeIdentity()!,
              codexHome: path.join(agentDir, "other"),
            });
          }
          const options = {
            client,
            binding,
            appServer,
            agentDir,
            assertCurrent: vi.fn(),
          };
          if (mismatch === "none") {
            const first = await loadCodexNativeToolCatalog(options);
            expect(first).toEqual([tool]);
            const returned = first[0]!;
            if (returned.type !== "function" || !isJsonObject(returned.inputSchema)) {
              throw new Error("expected function declaration with an object schema");
            }
            returned.inputSchema.type = "array";
            expect(await loadCodexNativeToolCatalog(options)).toEqual([tool]);
          } else {
            await expect(loadCodexNativeToolCatalog(options)).rejects.toThrow(
              mismatch === "missing"
                ? "no verified thread path"
                : mismatch === "client"
                  ? "original live client"
                  : mismatch === "fingerprint"
                    ? "native tool catalog is missing, corrupt, or changed"
                    : "original verified local binding and selected native connection",
            );
          }
          expect(request).toHaveBeenCalledTimes(mismatch === "missing" ? 1 : 0);
          if (mismatch === "missing") {
            expect(request).toHaveBeenCalledWith("thread/read", { threadId, includeTurns: false });
          }
        },
      });
    },
  );
});
