import fs from "node:fs";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { msteamsSetupContract } from "./setup-core.js";

const resolveMSTeamsCredentials = vi.hoisted(() => vi.fn());
const packageJson = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  openclaw?: { channel?: { setup?: { fields?: Array<Record<string, unknown>> } } };
};

vi.mock("./token.js", () => ({
  hasConfiguredMSTeamsCredentials: vi.fn(),
  resolveMSTeamsCredentials,
}));

describe("msteams environment authentication setup", () => {
  beforeEach(() => {
    resolveMSTeamsCredentials.mockReset();
  });

  it("registers secret and federated environment inputs for authentication-aware validation", () => {
    const useEnv = msteamsSetupContract.metadata.fields.find((field) => field.key === "useEnv");

    expect(useEnv).toMatchObject({
      envVarMode: "any",
      envVars: [
        "MSTEAMS_APP_ID",
        "MSTEAMS_APP_PASSWORD",
        "MSTEAMS_TENANT_ID",
        "MSTEAMS_AUTH_TYPE",
        "MSTEAMS_CERTIFICATE_PATH",
        "MSTEAMS_USE_MANAGED_IDENTITY",
      ],
    });
    expect(
      packageJson.openclaw?.channel?.setup?.fields?.find((field) => field.key === "useEnv"),
    ).toEqual(useEnv);
  });

  it("rejects --use-env when only persisted credentials are complete", () => {
    resolveMSTeamsCredentials.mockImplementation((config) =>
      config
        ? {
            type: "secret",
            appId: "persisted-app",
            appPassword: "persisted-password",
            tenantId: "persisted-tenant",
          }
        : undefined,
    );

    expect(
      msteamsSetupContract.validateInput?.({
        cfg: {
          channels: {
            msteams: {
              appId: "persisted-app",
              appPassword: "persisted-password",
              tenantId: "persisted-tenant",
            },
          },
        },
        accountId: DEFAULT_ACCOUNT_ID,
        input: { useEnv: true },
      }),
    ).toBe(
      "MS Teams --use-env requires complete secret, certificate, or managed-identity environment credentials.",
    );
  });

  it("selects environment credentials without changing sibling account authority", () => {
    resolveMSTeamsCredentials.mockReturnValue({
      type: "federated",
      appId: "environment-app",
      tenantId: "environment-tenant",
      useManagedIdentity: true,
    });
    const cfg = {
      channels: {
        msteams: {
          appId: "persisted-default-app",
          appPassword: "persisted-default-password",
          tenantId: "shared-tenant",
          authType: "federated" as const,
          certificatePath: "/secure/shared.pem",
          webhook: { port: 3978, path: "/api/messages" },
          accounts: {
            sibling: {
              appId: "sibling-app",
              appPassword: "sibling-password",
              webhook: { port: 3979 },
            },
          },
        },
      },
    };
    const input = { useEnv: true };

    expect(
      msteamsSetupContract.validateInput?.({ cfg, accountId: DEFAULT_ACCOUNT_ID, input }),
    ).toBeNull();
    const result = msteamsSetupContract.applyAccountConfig({
      cfg,
      accountId: DEFAULT_ACCOUNT_ID,
      input,
    });

    expect(result.channels?.msteams).toEqual({
      enabled: true,
      webhook: { path: "/api/messages" },
      accounts: {
        default: {
          enabled: true,
          webhook: { port: 3978 },
        },
        sibling: {
          appId: "sibling-app",
          appPassword: "sibling-password",
          tenantId: "shared-tenant",
          authType: "federated",
          certificatePath: "/secure/shared.pem",
          webhook: { port: 3979 },
        },
      },
    });
  });

  it("switches to secret auth only for a complete explicit replacement", () => {
    resolveMSTeamsCredentials.mockReturnValue({
      type: "federated",
      appId: "old-app",
      tenantId: "tenant-id",
      useManagedIdentity: true,
    });
    const cfg = {
      channels: {
        msteams: {
          authType: "federated" as const,
          appId: "old-app",
          tenantId: "tenant-id",
          useManagedIdentity: true,
        },
      },
    };
    const input = {
      useEnv: true,
      appId: "new-app",
      appPassword: "new-password",
      tenantId: "new-tenant",
    };

    expect(
      msteamsSetupContract.validateInput?.({ cfg, accountId: DEFAULT_ACCOUNT_ID, input }),
    ).toBeNull();
    const result = msteamsSetupContract.applyAccountConfig({
      cfg,
      accountId: DEFAULT_ACCOUNT_ID,
      input,
    });

    expect(result.channels?.msteams?.accounts?.default).toMatchObject({
      authType: "secret",
      appId: "new-app",
      appPassword: "new-password",
      tenantId: "new-tenant",
    });
    expect(result.channels?.msteams?.accounts?.default?.useManagedIdentity).toBeUndefined();
  });
});
