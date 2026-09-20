import { expect, it } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { buildSubagentRunReadIndexFromRuns } from "../agents/subagents/registry/subagent-registry-queries.js";
import { buildAgentRunProjectionIndex } from "../infra/agent-run-projection.js";
import type { AgentRunContext } from "../infra/agent-run-registry.types.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";

const parent = "agent:main:parent";
const child = "agent:main:subagent:child";
const cases: {
  name: string;
  childKey?: string;
  context?: Partial<AgentRunContext>;
  active: boolean;
}[] = [
  { name: "key-derived owner", active: true },
  { name: "normalized explicit owner", context: { agentId: " MAIN " }, active: true },
  { name: "different explicit owner", context: { agentId: "other" }, active: false },
  { name: "empty explicit owner", context: { agentId: "" }, active: false },
  { name: "existing blank-owner normalization", context: { agentId: " " }, active: true },
  { name: "existing invalid-owner normalization", context: { agentId: "!" }, active: true },
  {
    name: "opaque peer and differently cased agent",
    childKey: "agent:MAIN:matrix:channel:!MiXeD:example.org",
    context: { agentId: "main" },
    active: true,
  },
  { name: "ownerless unscoped key", childKey: "subagent:child", active: false },
  {
    name: "explicitly owned unscoped key",
    childKey: "subagent:child",
    context: { agentId: "main" },
    active: false,
  },
  { name: "malformed scoped key", childKey: "agent::subagent:child", active: false },
  {
    name: "session ID without a matching key",
    context: { agentId: "main", sessionKey: undefined, sessionId: child },
    active: false,
  },
  { name: "padded context key", context: { sessionKey: ` ${child} ` }, active: false },
  {
    name: "context key with different bytes",
    context: { sessionKey: "agent:MAIN:subagent:child" },
    active: false,
  },
  { name: "retired lifecycle", context: { lifecycleGeneration: "retired" }, active: false },
  {
    name: "suppressed capacity wait",
    context: { projectSessionActive: false, capacityWaits: new Set([Symbol("wait")]) },
    active: false,
  },
  {
    name: "explicit progress independent of lifecycle display",
    context: { projectSessionLifecycle: false, isControlUiVisible: false },
    active: true,
  },
];

it.each(cases)(
  "preserves follow-up ancestor membership for $name",
  ({ childKey, context, active }) => {
    const key = childKey ?? child;
    const retained = createSubagentRunRecord({
      runId: "retained",
      childSessionKey: key,
      requesterSessionKey: parent,
      createdAt: 1,
      endedAt: 2,
    });
    const rowContext = buildSessionListRowMetadataContext({
      now: 3,
      subagentRuns: buildSubagentRunReadIndexFromRuns({
        runs: new Map([[retained.runId, retained]]),
      }),
      projectedAgentRuns: buildAgentRunProjectionIndex({
        lifecycleGeneration: "current",
        contexts: [
          {
            lifecycleGeneration: "current",
            sessionKey: key,
            projectSessionActive: true,
            ...context,
          },
        ],
      }),
    });
    expect(rowContext.projectedSubagentActivity).toEqual(new Set(active ? [parent] : []));
  },
);

it("uses the latest retained parent and terminates cyclic ancestry", () => {
  const ancestor = "agent:main:ancestor";
  const records = [
    createSubagentRunRecord({
      runId: "retired-parent",
      childSessionKey: child,
      requesterSessionKey: "agent:main:retired-parent",
      generation: 1,
      createdAt: 1,
      endedAt: 2,
    }),
    createSubagentRunRecord({
      runId: "current-parent",
      childSessionKey: child,
      requesterSessionKey: parent,
      generation: 2,
      createdAt: 3,
      endedAt: 4,
    }),
    ...(
      [
        [parent, ancestor],
        [ancestor, parent],
      ] as const
    ).map(([key, requester]) =>
      createSubagentRunRecord({
        runId: key,
        childSessionKey: key,
        requesterSessionKey: requester,
        createdAt: 1,
        endedAt: 2,
      }),
    ),
  ];
  const rowContext = buildSessionListRowMetadataContext({
    now: 5,
    subagentRuns: buildSubagentRunReadIndexFromRuns({
      runs: new Map(records.map((record) => [record.runId, record])),
    }),
    projectedAgentRuns: buildAgentRunProjectionIndex({
      lifecycleGeneration: "current",
      contexts: [{ lifecycleGeneration: "current", sessionKey: child, projectSessionActive: true }],
    }),
  });
  expect(rowContext.projectedSubagentActivity).toEqual(new Set([parent, ancestor]));
});
