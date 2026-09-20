// Register suite mocks before imports that read the install catalog.
import "./missing-configured-plugin-install.suite.test-support.js";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";

const { mocks, testEnv, setupPluginInstallSuite } =
  await import("./missing-configured-plugin-install.suite.test-support.js");

describe("configured plugin install health findings", () => {
  setupPluginInstallSuite();

  it("maps a missing beta-channel plugin to a structured finding and dry-run effect offline", async () => {
    mocks.resolveNpmSpecMetadata.mockImplementation(() => {
      throw new Error("Health detection must not query the npm registry.");
    });
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "matrix",
        pluginId: "matrix",
        meta: { label: "Matrix" },
        install: {
          npmSpec: "@openclaw/plugin-matrix",
          expectedIntegrity: "sha512-test",
        },
        trustedSourceLinkedOfficialInstall: true,
      },
    ]);

    const {
      configuredPluginInstallIssueToHealthFinding,
      configuredPluginInstallIssueToRepairEffect,
      detectConfiguredPluginInstallHealthIssues,
    } = await import("./missing-configured-plugin-install.js");
    const [issue] = await detectConfiguredPluginInstallHealthIssues({
      cfg: {
        update: { channel: "beta" },
        channels: {
          matrix: { enabled: true, homeserver: "https://matrix.example.org" },
        },
      },
      env: testEnv,
    });

    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(mocks.resolveNpmSpecMetadata).not.toHaveBeenCalled();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecordsWithLease).not.toHaveBeenCalled();
    expect(issue).toEqual({
      kind: "missing-install-record",
      pluginId: "matrix",
      installSpec: "@openclaw/plugin-matrix",
    });
    expect(
      configuredPluginInstallIssueToHealthFinding(expectDefined(issue, "issue test invariant")),
    ).toMatchObject({
      checkId: "core/doctor/configured-plugin-installs",
      severity: "warning",
      target: "matrix",
      fixHint: "Run `openclaw doctor --fix` to install @openclaw/plugin-matrix.",
    });
    expect(
      configuredPluginInstallIssueToRepairEffect(expectDefined(issue, "issue test invariant")),
    ).toEqual({
      kind: "package",
      action: "would-install-configured-plugin",
      target: "matrix",
      dryRunSafe: false,
    });
  });

  it("maps package-update deferrals to structured findings without installing packages", async () => {
    const missingDiscordPath = path.resolve("/missing/discord");
    const records = {
      discord: {
        source: "npm",
        spec: "@openclaw/discord",
        installPath: missingDiscordPath,
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "discord",
        pluginId: "discord",
        meta: { label: "Discord" },
        install: {
          npmSpec: "@openclaw/discord",
        },
      },
    ]);

    const {
      configuredPluginInstallIssueToHealthFinding,
      configuredPluginInstallIssueToRepairEffect,
      detectConfiguredPluginInstallHealthIssues,
    } = await import("./missing-configured-plugin-install.js");
    const [issue] = await detectConfiguredPluginInstallHealthIssues({
      cfg: {
        plugins: {
          entries: {
            discord: { enabled: true },
          },
        },
        channels: {
          discord: { enabled: true },
        },
      },
      env: {
        ...testEnv,
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
      },
    });

    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(issue).toEqual({
      kind: "deferred-package-manager-repair",
      pluginId: "discord",
      installPath: missingDiscordPath,
    });
    expect(
      configuredPluginInstallIssueToHealthFinding(expectDefined(issue, "issue test invariant")),
    ).toMatchObject({
      checkId: "core/doctor/configured-plugin-installs",
      severity: "warning",
      path: missingDiscordPath,
      target: "discord",
    });
    expect(
      configuredPluginInstallIssueToRepairEffect(expectDefined(issue, "issue test invariant")),
    ).toEqual({
      kind: "package",
      action: "would-defer-configured-plugin-install-repair",
      target: "discord",
      dryRunSafe: true,
    });
  });

  it("reports one finding when a configured plugin record points at a missing package", async () => {
    const missingDiscordPath = path.resolve("/missing/discord");
    const records = {
      discord: {
        source: "npm",
        spec: "@openclaw/discord",
        installPath: missingDiscordPath,
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "discord",
        pluginId: "discord",
        meta: { label: "Discord" },
        install: {
          npmSpec: "@openclaw/discord",
        },
      },
    ]);

    const {
      detectConfiguredPluginInstallHealthIssues,
      configuredPluginInstallIssueToHealthFinding,
    } = await import("./missing-configured-plugin-install.js");
    const issues = await detectConfiguredPluginInstallHealthIssues({
      cfg: {
        plugins: {
          entries: {
            discord: { enabled: true },
          },
        },
        channels: {
          discord: { enabled: true },
        },
      },
      env: testEnv,
    });

    expect(issues).toEqual([
      {
        kind: "missing-installed-payload",
        pluginId: "discord",
        installPath: missingDiscordPath,
        installSpec: "@openclaw/discord",
      },
    ]);
    expect(
      configuredPluginInstallIssueToHealthFinding(
        expectDefined(issues[0], "missing payload issue"),
      ),
    ).toMatchObject({
      target: "discord",
      fixHint:
        "Run `openclaw plugins install @openclaw/discord --force` to reinstall the configured plugin package.",
    });
  });
});
