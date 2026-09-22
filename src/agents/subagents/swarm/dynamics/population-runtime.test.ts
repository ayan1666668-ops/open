import { describe, expect, it } from "vitest";
import { diagnoseHostCollectorPopulation } from "./population-runtime.js";

describe("host-owned collector dynamics telemetry", () => {
  it("keeps semantic candidate signals unknown for successful collectors", () => {
    expect(
      diagnoseHostCollectorPopulation({
        groupId: "swarm:test",
        maxConcurrent: 4,
        records: [{ runId: "run-1", terminalStatus: "done" }],
      }),
    ).toMatchObject({
      decision: {
        authority: "search-only",
        actions: [{ kind: "hold" }],
      },
      diagnostic: {
        hostMeasurementCount: 3,
        externalMeasurementCount: 0,
        candidateEntropy: null,
        evidenceCompleteness: null,
        acceptanceProgress: null,
        meanCorrelation: null,
        meanCorrelationSource: null,
      },
    });
  });

  it("turns host-observed terminal failure into advisory debt pressure", () => {
    expect(
      diagnoseHostCollectorPopulation({
        groupId: "swarm:test",
        maxConcurrent: 4,
        records: [
          { runId: "run-1", terminalStatus: "failed" },
          { runId: "run-2", terminalStatus: "done" },
        ],
      }),
    ).toMatchObject({
      decision: {
        authority: "search-only",
        actions: [{ kind: "drain" }],
      },
    });
  });

  it("treats scheduler saturation as measured pressure without inventing evidence", () => {
    expect(
      diagnoseHostCollectorPopulation({
        groupId: "swarm:test",
        maxConcurrent: 2,
        records: [
          { runId: "run-1", terminalStatus: null },
          { runId: "run-2", terminalStatus: null },
        ],
      }),
    ).toMatchObject({
      decision: {
        actions: [{ kind: "drain" }],
      },
    });
  });
});
