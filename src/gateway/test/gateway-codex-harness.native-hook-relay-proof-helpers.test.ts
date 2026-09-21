import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertCapturedApprovalRoundTrip,
  CODEX_APPROVAL_REQUEST_METHOD,
  prepareRelayProofCapture,
  readCapturedApprovalRoundTrip,
} from "./gateway-codex-harness.native-hook-relay-proof.test-helpers.js";

describe("native relay proof capture", () => {
  let proofDir: string;

  beforeEach(async () => {
    proofDir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-proof-capture-"));
  });

  afterEach(async () => {
    await fs.rm(proofDir, { recursive: true, force: true });
  });

  it.each(["rpc-in.jsonl", "rpc-out.jsonl"])(
    "refuses existing %s without replacing prior evidence",
    async (filename) => {
      const prior = `${JSON.stringify({ id: 1, method: "thread/start", params: { config: {} } })}\n`;
      const capturePath = path.join(proofDir, filename);
      await fs.writeFile(capturePath, prior);

      await expect(prepareRelayProofCapture(proofDir)).rejects.toThrow();
      expect(await fs.readFile(capturePath, "utf8")).toBe(prior);
    },
  );

  it("allows append-only capture for one fresh run", async () => {
    await prepareRelayProofCapture(proofDir);
    await fs.appendFile(path.join(proofDir, "rpc-in.jsonl"), '{"method":"thread/start"}\n');
    await fs.appendFile(path.join(proofDir, "rpc-out.jsonl"), '{"id":1,"result":{}}\n');

    await expect(prepareRelayProofCapture(proofDir)).rejects.toThrow();
    expect(await fs.readFile(path.join(proofDir, "rpc-in.jsonl"), "utf8")).toContain(
      '"thread/start"',
    );
  });

  const command = "printf APPROVAL-CURRENT";
  const capturedCommand = `/bin/bash -lc '${command}'`;

  async function captureApproval(requestCommand: unknown, response: Record<string, unknown>) {
    await fs.writeFile(
      path.join(proofDir, "rpc-out.jsonl"),
      `${JSON.stringify({
        id: 17,
        method: CODEX_APPROVAL_REQUEST_METHOD,
        params: { threadId: "thread-current", turnId: "turn-current", command: requestCommand },
      })}\n`,
    );
    await fs.writeFile(path.join(proofDir, "rpc-in.jsonl"), `${JSON.stringify(response)}\n`);
    return await readCapturedApprovalRoundTrip({
      proofDir,
      command,
      timeoutMs: 0,
    });
  }

  it.each([`/bin/bash -lc 'echo ${command}'`, `/bin/bash -lc '${command}; true'`, undefined])(
    "rejects an altered or absent command: %s",
    async (invalidCommand) => {
      const roundTrip = await captureApproval(invalidCommand, {
        id: 17,
        result: { decision: "accept" },
      });
      expect(roundTrip.request).toBeUndefined();
      expect(() => assertCapturedApprovalRoundTrip(roundTrip, command)).toThrow();
    },
  );

  it("does not pair another request's response", async () => {
    const roundTrip = await captureApproval(capturedCommand, {
      id: 18,
      result: { decision: "accept" },
    });
    expect(roundTrip.request).toBeDefined();
    expect(roundTrip.response).toBeUndefined();
    expect(() => assertCapturedApprovalRoundTrip(roundTrip, command)).toThrow();
  });

  it.each(["accept", "acceptForSession", "decline", "cancel"])(
    "accepts the exact command's %s decision",
    async (decision) => {
      const roundTrip = await captureApproval(capturedCommand, { id: 17, result: { decision } });
      expect(assertCapturedApprovalRoundTrip(roundTrip, command)).toBe(decision);
    },
  );

  it.each([
    { error: { code: -32603, message: "fixture error" }, result: { decision: "accept" } },
    { result: {} },
    { result: { decision: "unknown" } },
  ])("rejects a protocol error or invalid decision: %j", async (response) => {
    const roundTrip = await captureApproval(capturedCommand, { id: 17, ...response });
    expect(() => assertCapturedApprovalRoundTrip(roundTrip, command)).toThrow();
  });
});
