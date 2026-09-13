import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listMSTeamsAccountIds, resolveMSTeamsRuntimeAccount } from "./accounts.js";

describe("msteams account selection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not let partial default environment credentials override a configured named account", () => {
    vi.stubEnv("MSTEAMS_APP_ID", "partial-default-app-id");
    vi.stubEnv("MSTEAMS_APP_PASSWORD", "");
    vi.stubEnv("MSTEAMS_TENANT_ID", "");
    const cfg = {
      channels: {
        msteams: {
          accounts: {
            support: {
              appId: "support-app-id",
              appPassword: "support-secret",
              tenantId: "support-tenant-id",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(listMSTeamsAccountIds(cfg)).toEqual(["support"]);
    expect(resolveMSTeamsRuntimeAccount({ cfg })).toMatchObject({
      accountId: "support",
      credentials: {
        appId: "support-app-id",
        appPassword: "support-secret",
        tenantId: "support-tenant-id",
      },
    });
  });
});
