import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type WorkflowStep = {
  "continue-on-error"?: boolean;
  env?: Record<string, string>;
  id?: string;
  if?: string;
  uses?: string;
  with?: Record<string, string>;
};

type WorkflowJob = {
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  steps: WorkflowStep[];
};

const workflow = parse(readFileSync(".github/workflows/dependency-guard.yml", "utf8")) as {
  jobs: Record<string, WorkflowJob>;
};

describe("dependency guard autoscrub workflow", () => {
  it("never schedules autoscrub from the review signal", () => {
    expect(workflow.jobs["dependency-guard-detect"]?.if).toContain(
      "github.event_name == 'pull_request_target'",
    );
  });
  it("limits app write credentials to the detected autoscrub repository", () => {
    const autoscrub = workflow.jobs["dependency-guard-autoscrub"];
    expect(autoscrub?.needs).toBe("dependency-guard-detect");
    expect(autoscrub?.if).toContain("needs.dependency-guard-detect.outputs.autoscrub == 'true'");
    const tokenSteps = autoscrub?.steps.filter((step) =>
      step.uses?.startsWith("actions/create-github-app-token@"),
    );
    expect(tokenSteps).toHaveLength(2);
    for (const step of tokenSteps ?? []) {
      expect(step.with).toMatchObject({
        owner: "${{ needs.dependency-guard-detect.outputs.autoscrub-owner }}",
        repositories: "${{ needs.dependency-guard-detect.outputs.autoscrub-repository }}",
        "permission-contents": "write",
      });
      expect(step["continue-on-error"]).toBe(true);
    }
    expect(tokenSteps?.[1]?.if).toBe("steps.app-token.outcome == 'failure'");
    const autoscrubStep = autoscrub?.steps.find(
      (step) => step.env?.OPENCLAW_DEPENDENCY_GUARD_MODE === "autoscrub",
    );
    expect(autoscrubStep?.env?.GITHUB_TOKEN).toBe("${{ github.token }}");
    expect(autoscrubStep?.env?.OPENCLAW_DEPENDENCY_GUARD_AUTOSCRUB_TOKEN).toBe(
      "${{ steps.app-token.outputs.token || steps.app-token-fallback.outputs.token }}",
    );
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (name === "dependency-guard-autoscrub") {
        continue;
      }
      for (const step of job.steps) {
        expect(step.uses?.startsWith("actions/create-github-app-token@")).not.toBe(true);
        expect(step.env?.OPENCLAW_DEPENDENCY_GUARD_AUTOSCRUB_TOKEN).toBeUndefined();
      }
    }
  });

  it("publishes the final review decision after detection and any autoscrub attempt", () => {
    const detect = workflow.jobs["dependency-guard-detect"];
    const final = workflow.jobs["dependency-guard"];
    expect(detect?.outputs).toMatchObject({
      autoscrub: "${{ steps.guard.outputs.autoscrub }}",
      "autoscrub-owner": "${{ steps.guard.outputs.autoscrub-owner }}",
      "autoscrub-repository": "${{ steps.guard.outputs.autoscrub-repository }}",
    });
    expect(
      detect?.steps.find((step) => step.id === "guard")?.env?.OPENCLAW_DEPENDENCY_GUARD_MODE,
    ).toBe("detect");
    expect(final?.needs).toEqual(["dependency-guard-detect", "dependency-guard-autoscrub"]);
    expect(final?.if).toContain("always()");
    expect(
      final?.steps.some((step) => step.env?.OPENCLAW_DEPENDENCY_GUARD_MODE === "enforce"),
    ).toBe(true);
  });
});
