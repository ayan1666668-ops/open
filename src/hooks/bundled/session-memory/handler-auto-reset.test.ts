import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { replaceTranscriptEvents } from "../../../config/sessions/session-accessor.js";
import { createInternalHookEvent } from "../../internal-hooks.js";
import handler, { flushSessionMemoryWritesForTest } from "./handler.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session-memory automatic reset", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-session-memory-auto-");
  });

  afterEach(async () => {
    await flushSessionMemoryWritesForTest();
  });

  it.each(["daily", "idle"] as const)(
    "creates memory from the ended session on %s reset",
    async (reason) => {
      const sessionKey = "agent:main:main";
      const sessionId = `${reason}-session`;
      const storePath = path.join(tempDir, "sessions.json");
      const cfg = {
        agents: { defaults: { workspace: tempDir } },
        session: { store: storePath },
      } satisfies OpenClawConfig;
      await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, [
        {
          type: "message",
          id: `${reason}-user`,
          parentId: null,
          message: {
            role: "user",
            content: `Remember the ${reason} rollover`,
            __openclaw: { senderIsOwner: true },
          },
        },
        {
          type: "message",
          id: `${reason}-assistant`,
          parentId: `${reason}-user`,
          message: { role: "assistant", content: "Captured automatically" },
        },
      ]);
      const event = createInternalHookEvent("session", "auto-reset", sessionKey, {
        cfg,
        agentId: "main",
        workspaceDir: tempDir,
        storePath,
        sessionEntry: { sessionId },
        reason,
      });

      const completed = handler(event);
      expect(completed).toBeInstanceOf(Promise);
      await completed;

      const memoryDir = path.join(tempDir, "memory");
      const files = await fs.readdir(memoryDir);
      const memoryContent = await fs.readFile(
        path.join(memoryDir, expectDefined(files[0], "files[0] test invariant")),
        "utf8",
      );
      expect(files).toHaveLength(1);
      expect(memoryContent).toContain(`- **Reason**: ${reason}`);
      expect(memoryContent).toContain(`user: ${JSON.stringify(`Remember the ${reason} rollover`)}`);
      expect(memoryContent).toContain(`assistant: ${JSON.stringify("Captured automatically")}`);
    },
  );

  it("dates the artifact from the captured conversation, not the reset trigger", async () => {
    const sessionKey = "agent:main:main";
    const sessionId = "cross-day-session";
    const storePath = path.join(tempDir, "sessions.json");
    const cfg = {
      agents: { defaults: { workspace: tempDir, userTimezone: "UTC" } },
      session: { store: storePath },
    } satisfies OpenClawConfig;
    await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, [
      {
        type: "message",
        id: "cross-day-user",
        parentId: null,
        timestamp: Date.parse("2026-09-21T14:59:00.000Z"),
        message: {
          role: "user",
          content: "Plan tomorrow's rollout",
          __openclaw: { senderIsOwner: true },
        },
      },
      {
        type: "message",
        id: "cross-day-assistant",
        parentId: "cross-day-user",
        timestamp: Date.parse("2026-09-21T15:38:00.000Z"),
        message: { role: "assistant", content: "Rollout plan captured" },
      },
    ]);
    const event = createInternalHookEvent("session", "auto-reset", sessionKey, {
      cfg,
      agentId: "main",
      workspaceDir: tempDir,
      storePath,
      sessionEntry: { sessionId },
      reason: "idle",
    });
    event.timestamp = new Date(Date.parse("2026-09-22T08:56:00.000Z"));

    await handler(event);

    const memoryDir = path.join(tempDir, "memory");
    const files = await fs.readdir(memoryDir);
    expect(files).toEqual(["2026-09-21-1538.md"]);
    const memoryContent = await fs.readFile(
      path.join(memoryDir, expectDefined(files[0], "files[0] test invariant")),
      "utf8",
    );
    expect(memoryContent).toMatch(/^# Session: 2026-09-21 15:38:00 UTC/);
    expect(memoryContent).toContain(`assistant: ${JSON.stringify("Rollout plan captured")}`);
  });
});
