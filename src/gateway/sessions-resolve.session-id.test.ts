import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import { resolveSessionKeyFromResolveParams } from "./sessions-resolve.js";

describe("sessionId resolution", () => {
  it("filters unrelated entries before owner projection", async () => {
    const unrelated = {
      sessionId: "other-session",
      updatedAt: 2,
    } as SessionEntry;
    const cfg = { agents: { entries: { main: {} } } } as OpenClawConfig;
    const projection = createSessionRowProjectionFixture({
      cfg,
      agentId: "main",
      store: {
        "agent:main:target": { sessionId: "target-session", updatedAt: 1 },
        "agent:main:unrelated": unrelated,
      },
    });
    Object.defineProperty(unrelated, "owner", {
      get: () => {
        throw new Error("unrelated entry reached owner projection");
      },
    });

    await expect(
      resolveSessionKeyFromResolveParams({
        cfg,
        client: null,
        p: { agentId: "main", sessionId: "target-session" },
        projection,
      }),
    ).resolves.toMatchObject({
      ok: true,
      key: "agent:main:target",
      agentId: "main",
    });
  });
});
