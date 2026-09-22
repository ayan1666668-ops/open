// Inbound media ownership tests cover the binding the assistant media route enforces:
// a staged object is bound from the moment it is published, and the session that
// persists the reference becomes its owner.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  collectInboundMediaIds,
  inboundMediaIdFromReference,
  isSafeInboundMediaId,
  recordInboundMediaOwner,
  recordInboundMediaOwnersInValue,
  recordStagedInboundMedia,
  resolveInboundMediaOwnership,
} from "./inbound-media-ownership.js";
import { getMediaDir } from "./store.js";

/** Writes the registry directly, the way a store that outlived its files would hold it. */
async function writeRegistry(index: Record<string, { stagedAt: number; sessionKey?: string }>) {
  const target = path.join(getMediaDir(), "inbound-ownership.json");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(index), "utf8");
  return target;
}

/** Creates the bytes a record names, inside the bucket the registry tracks. */
async function writeInboundBytes(id: string): Promise<void> {
  const inboundDir = path.join(getMediaDir(), "inbound");
  await fs.mkdir(inboundDir, { recursive: true });
  await fs.writeFile(path.join(inboundDir, id), "inbound bytes", "utf8");
}

async function withStateDir(run: () => Promise<void>): Promise<void> {
  const env = captureEnv(["OPENCLAW_STATE_DIR"]);
  try {
    await withTestDir({ prefix: "openclaw-inbound-ownership-" }, async (stateDir) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      await run();
    });
  } finally {
    env.restore();
  }
}

describe("inbound media ownership", () => {
  it("marks a staged object before any session is known", async () => {
    await withStateDir(async () => {
      expect(await recordStagedInboundMedia("staged-one.png")).toBe(true);
      const ownership = await resolveInboundMediaOwnership("staged-one.png");
      expect(ownership?.stagedAt).toEqual(expect.any(Number));
      expect(ownership?.sessionKey).toBeUndefined();
    });
  });

  it("binds the owner session and keeps the staged time", async () => {
    await withStateDir(async () => {
      await recordStagedInboundMedia("staged-two.png");
      const stagedAt = (await resolveInboundMediaOwnership("staged-two.png"))?.stagedAt;
      expect(await recordInboundMediaOwner("staged-two.png", { sessionKey: "agent:main:a" })).toBe(
        true,
      );
      const ownership = await resolveInboundMediaOwnership("staged-two.png");
      expect(ownership).toMatchObject({ sessionKey: "agent:main:a", stagedAt });
    });
  });

  it("leaves objects that were never staged unowned", async () => {
    await withStateDir(async () => {
      expect(await resolveInboundMediaOwnership("channel-attachment.png")).toBeUndefined();
    });
  });

  it("refuses ids that are not a single bounded path component", async () => {
    await withStateDir(async () => {
      for (const id of [
        "",
        ".",
        "..",
        "../escape.png",
        "nested/escape.png",
        "nested\\escape.png",
      ]) {
        expect(isSafeInboundMediaId(id), id).toBe(false);
        expect(await recordStagedInboundMedia(id), id).toBe(false);
        expect(await resolveInboundMediaOwnership(id), id).toBeUndefined();
      }
      expect(isSafeInboundMediaId("safe.png")).toBe(true);
    });
  });

  it("parses only canonical managed references", () => {
    expect(inboundMediaIdFromReference("media://inbound/one.png")).toBe("one.png");
    expect(inboundMediaIdFromReference("media://inbound/a%20b.png")).toBe("a b.png");
    for (const source of [
      "media://other/one.png",
      "media://inbound/nested/one.png",
      "media://inbound/",
      "/tmp/one.png",
      "https://files.example/one.png",
      "media://inbound/one.png?ticket=1",
    ]) {
      expect(inboundMediaIdFromReference(source), source).toBeUndefined();
    }
  });

  // The registry is the only thing that keeps a staged object bound, so a record may be
  // forgotten only once the bytes it names are gone. Age and size alone are reasons to
  // re-examine a record, never reasons to forget a live one.
  it("keeps a live binding over the bound and reaps only records whose bytes are gone", async () => {
    await withStateDir(async () => {
      const liveId = "over-bound-live-image.png";
      await writeInboundBytes(liveId);
      // The live record is the OLDEST, so a registry that keeps its newest entries when it
      // overflows discards exactly the binding that still has bytes to protect.
      const deadIds = Array.from(
        { length: 5000 },
        (_, position) => `over-bound-dead-${position}.png`,
      );
      const index: Record<string, { stagedAt: number }> = { [liveId]: { stagedAt: 1 } };
      deadIds.forEach((id, position) => {
        index[id] = { stagedAt: 2 + position };
      });
      await writeRegistry(index);

      // Any write runs the prune, so the next staged object is what re-examines the registry.
      expect(await recordStagedInboundMedia("over-bound-fresh.png")).toBe(true);

      const live = await resolveInboundMediaOwnership(liveId);
      expect(live?.stagedAt).toBe(1);
      expect(live?.sessionKey).toBeUndefined();
      expect(await resolveInboundMediaOwnership(deadIds[0]!)).toBeUndefined();
    });
  });

  it("keeps a record whose bytes still exist however old the record is", async () => {
    await withStateDir(async () => {
      const liveId = "ancient-live-image.png";
      await writeInboundBytes(liveId);
      await writeRegistry({ [liveId]: { stagedAt: 1, sessionKey: "agent:main:ancient" } });

      expect(await recordStagedInboundMedia("ancient-fresh-image.png")).toBe(true);

      expect(await resolveInboundMediaOwnership(liveId)).toMatchObject({
        stagedAt: 1,
        sessionKey: "agent:main:ancient",
      });
    });
  });

  // An empty registry is the state in which nothing is bound, so a registry that cannot be
  // READ must never be reported as one: the records it holds are the only thing keeping
  // staged objects bound, and a rewrite from an empty index deletes them.
  it.each(["{ this is not json", "[]", '"an ownership index"'])(
    "reports a registry it cannot read instead of an empty registry: %s",
    async (contents) => {
      await withStateDir(async () => {
        const target = await writeRegistry({});
        await fs.writeFile(target, contents, "utf8");

        await expect(resolveInboundMediaOwnership("bound.png")).rejects.toThrow();
        expect(await recordStagedInboundMedia("fresh.png")).toBe(false);
        expect(await fs.readFile(target, "utf8")).toBe(contents);
      });
    },
  );

  it("reports an unreadable registry file instead of an empty registry", async () => {
    await withStateDir(async () => {
      const target = path.join(getMediaDir(), "inbound-ownership.json");
      await fs.mkdir(target, { recursive: true });

      await expect(resolveInboundMediaOwnership("bound.png")).rejects.toThrow();
      expect(await recordStagedInboundMedia("fresh.png")).toBe(false);
    });
  });

  it("binds every staged reference a persisted value carries", async () => {
    await withStateDir(async () => {
      await recordStagedInboundMedia("persisted.png");
      const message = {
        role: "toolResult",
        content: [
          { type: "text", text: "loaded" },
          { type: "image", mimeType: "image/png", url: "media://inbound/persisted.png" },
        ],
        details: { media: { mediaUrls: ["media://inbound/never-staged.png"] } },
      };
      expect(collectInboundMediaIds(message)).toEqual(["persisted.png", "never-staged.png"]);
      const bound = await recordInboundMediaOwnersInValue(message, { sessionKey: "agent:main:b" });
      expect(bound).toEqual(["persisted.png"]);
      expect((await resolveInboundMediaOwnership("persisted.png"))?.sessionKey).toBe(
        "agent:main:b",
      );
      // A reference this registry never staged belongs to another lane, such as a channel
      // attachment, and binding it would narrow that lane's access.
      expect(await resolveInboundMediaOwnership("never-staged.png")).toBeUndefined();
    });
  });
});
