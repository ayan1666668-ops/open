import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { acquirePreparedModelRuntimeLeaseFromOwners } from "./prepared-model-runtime-lease.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  normalizePreparedModelRuntimeInput,
  ownerKey,
} from "./prepared-model-runtime.owner.js";
import { PreparedModelRuntimeOwnerRetention } from "./prepared-model-runtime.retention.js";
import type {
  PreparedModelRuntimeOwner,
  PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.types.js";

const config = { agents: { entries: { pilot: {} } } } satisfies OpenClawConfig;

function fakeSnapshot(label: string): PreparedModelRuntimeSnapshot {
  return { label } as unknown as PreparedModelRuntimeSnapshot;
}

describe("acquirePreparedModelRuntimeLeaseFromOwners", () => {
  it("fails instead of livelocking when the prepared snapshot never matches its owner (#153313)", async () => {
    const input = normalizePreparedModelRuntimeInput({
      agentId: "pilot",
      agentDir: "/tmp/agents/pilot",
      config,
    });
    const ownerSnapshot = fakeSnapshot("owner");
    const owner = {
      input,
      catalogOwner: undefined,
      environmentFingerprint: "",
      catalogMode: "static",
      provenance: "configured",
      generation: 1,
      needsRefresh: false,
      catalogStale: false,
      snapshot: ownerSnapshot,
    } as unknown as PreparedModelRuntimeOwner;
    const owners = new Map([[ownerKey(input), owner]]);
    // Simulates the defect: preparation resolves a snapshot that belongs to another owner
    // record, so the settled owner at this key can never equal what was prepared.
    const prepareSnapshot = vi.fn(async () => fakeSnapshot("other"));

    await expect(
      acquirePreparedModelRuntimeLeaseFromOwners(input, "run", {
        captureLifetime: () => () => {},
        owners,
        agentBuildCompletions: new Map(),
        retainedDirectRunOwners: new PreparedModelRuntimeOwnerRetention(4),
        retainedGatewayRunOwners: new PreparedModelRuntimeOwnerRetention(4),
        getBuildTimeoutMs: () => 1_000,
        getGatewayLifecycleActive: () => false,
        getPendingReplacement: () => undefined,
        prepareSnapshot,
      }),
    ).rejects.toBeInstanceOf(PreparedModelRuntimeOwnerNotPublishedError);

    // One retry tolerates a publication race; the repeated identical mismatch stops the loop.
    expect(prepareSnapshot).toHaveBeenCalledTimes(2);
    expect(owner.snapshot).toBe(ownerSnapshot);
  });
});
