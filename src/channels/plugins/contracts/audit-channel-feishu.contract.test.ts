import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  addChannelAllowFromStoreEntry,
  readChannelAllowFromStore,
} from "../../../pairing/pairing-store.js";
import { collectChannelSecurityFindingsCore } from "../../../security/audit-channel.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import type { ChannelPlugin } from "../types.plugin.js";
import { getBundledChannelPluginAsync } from "./test-helpers/bundled-channel-plugin-loader.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let feishuPlugin: ChannelPlugin;

function auditFeishu(cfg: OpenClawConfig) {
  return collectChannelSecurityFindingsCore({ cfg, plugins: [feishuPlugin] });
}

describe("Feishu DM security audit", () => {
  beforeAll(async () => {
    // This contract joins the public channel adapter with core audit, routing, and pairing state.
    const plugin = await getBundledChannelPluginAsync("feishu");
    if (!plugin) {
      throw new Error("Feishu channel plugin is unavailable");
    }
    feishuPlugin = plugin;
  });

  it("audits user_id pairing approvals only while the DM policy admits the store", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-feishu-audit-"));
    try {
      await addChannelAllowFromStoreEntry({
        channel: "feishu",
        accountId: "default",
        entry: "u123",
        pairingAdapter: feishuPlugin.pairing,
      });
      await expect(readChannelAllowFromStore("feishu", process.env, "default")).resolves.toEqual([
        "u123",
      ]);
      for (const dmPolicy of ["pairing", "allowlist"] as const) {
        const findings = await auditFeishu({
          agents: { entries: { main: {} } },
          session: { dmScope: "per-channel-peer" },
          bindings: ["ou_alice", "ou_bob"].map((id) => ({
            agentId: "main",
            match: { channel: "feishu", peer: { kind: "direct", id } },
            session: { dmScope: "main" },
          })),
          channels: {
            feishu: {
              appId: "fixture-app",
              appSecret: "fixture-secret",
              dmPolicy,
              allowFrom: dmPolicy === "allowlist" ? ["ou_alice"] : [],
            },
          },
        });

        expect(
          findings.some((finding) => finding.checkId.includes(".dm.routing_unverified.")),
        ).toBe(dmPolicy === "pairing");
        expect(findings.some((finding) => finding.checkId === "channels.feishu.dm.locked")).toBe(
          false,
        );
        expect(
          findings.filter((finding) => finding.checkId.includes(".dm.session_collision.")),
        ).toHaveLength(0);
      }
    } finally {
      closeOpenClawStateDatabaseForTest();
      vi.unstubAllEnvs();
    }
  });

  it.each(["feishu:*", "lark:*"])(
    "detects shared sessions for the %s wildcard",
    async (wildcard) => {
      const findings = await auditFeishu({
        agents: { entries: { main: {} } },
        session: { dmScope: "main" },
        channels: {
          feishu: {
            appId: "fixture-app",
            appSecret: "fixture-secret",
            dmPolicy: "allowlist",
            allowFrom: [wildcard],
          },
        },
      });

      expect(
        findings.filter((finding) => finding.checkId.includes(".dm.session_collision.")),
      ).toHaveLength(1);
      expect(findings.some((finding) => finding.checkId === "channels.feishu.dm.locked")).toBe(
        false,
      );
    },
  );

  it.each([
    { globalScope: "per-channel-peer", bindingScope: "main", collisions: 1 },
    { globalScope: "main", bindingScope: "per-channel-peer", collisions: 0 },
    { globalScope: "main", bindingScope: "main", collisions: 1 },
  ] as const)(
    "uses exact peer bindings with $bindingScope scope over global $globalScope",
    async ({ globalScope, bindingScope, collisions }) => {
      const findings = await auditFeishu({
        agents: { entries: { main: {} } },
        session: { dmScope: globalScope },
        bindings: ["ou_alice", "ou_bob"].map((id) => ({
          agentId: "main",
          match: { channel: "feishu", peer: { kind: "direct", id } },
          session: { dmScope: bindingScope },
        })),
        channels: {
          feishu: {
            appId: "fixture-app",
            appSecret: "fixture-secret",
            dmPolicy: "allowlist",
            allowFrom: ["ou_alice", "feishu:user:ou_bob", "lark:dm:ou_alice", "chat:oc_inert"],
          },
        },
      });

      const sessionCollisions = findings.filter((finding) =>
        finding.checkId.includes(".dm.session_collision."),
      );
      expect(sessionCollisions).toHaveLength(collisions);
      expect(findings.some((finding) => finding.checkId.includes(".dm.routing_unverified."))).toBe(
        false,
      );
      if (collisions > 0) {
        expect(sessionCollisions[0]?.detail).toContain("2 distinct admitted DM principals");
        expect(sessionCollisions[0]?.remediation).toContain("matching binding or session.dmScope");
      }
    },
  );

  it.each([
    { policy: "allowlist", allowFrom: ["u123", "u456"], unverified: true },
    { policy: "allowlist", allowFrom: ["u123"], unverified: true },
    { policy: "disabled", allowFrom: ["u123"], unverified: false },
  ] as const)(
    "reports user_id routing uncertainty for $allowFrom under $policy",
    async ({ policy, allowFrom, unverified }) => {
      const findings = await auditFeishu({
        agents: { entries: { main: {} } },
        session: { dmScope: "per-channel-peer" },
        bindings: ["ou_alice", "ou_bob"].map((id) => ({
          agentId: "main",
          match: { channel: "feishu", peer: { kind: "direct", id } },
          session: { dmScope: "main" },
        })),
        channels: {
          feishu: {
            appId: "fixture-app",
            appSecret: "fixture-secret",
            dmPolicy: policy,
            allowFrom: [...allowFrom],
          },
        },
      });

      const warning = findings.find(
        (finding) => finding.checkId === "channels.feishu.dm.routing_unverified.default",
      );
      expect(Boolean(warning)).toBe(unverified);
      if (unverified) {
        expect(warning).toMatchObject({
          severity: "warn",
          remediation: expect.stringContaining("open_id"),
        });
      }
      expect(findings.some((finding) => finding.checkId === "channels.feishu.dm.locked")).toBe(
        false,
      );
      expect(
        findings.filter((finding) => finding.checkId.includes(".dm.session_collision.")),
      ).toHaveLength(0);
    },
  );
});
