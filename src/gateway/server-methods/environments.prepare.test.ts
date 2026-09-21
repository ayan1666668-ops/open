import { describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createCoreGatewayMethodDescriptors } from "../methods/core-method-policy.js";
import { summarizeWorkerEnvironment } from "../worker-environments/environment-summary.js";
import { environmentsHandlers } from "./environments.js";
import {
  callEnvironmentMethod,
  FakeWorkerServiceError,
  mockContext,
  type TestWorkerService,
  workerRecord,
  workerService,
} from "./environments.test-support.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

describe("environments.prepare", () => {
  const request = { profileId: "development", projectPath: "/projects/app" };

  it("requires admin authority and ready sidecars before a control-plane write", () => {
    const descriptor = createCoreGatewayMethodDescriptors(environmentsHandlers).find(
      (entry) => entry.name === "environments.prepare",
    );
    expect(descriptor).toMatchObject({
      scope: "operator.admin",
      startup: "unavailable-until-sidecars",
      controlPlaneWrite: true,
    });
  });

  it.each([
    {},
    { profileId: "development" },
    { ...request, projectPath: "" },
    { ...request, setupAuthorized: false },
  ])("rejects invalid params before preparation: %j", async (params) => {
    const service = workerService();
    const [ok, , error] = await callEnvironmentMethod("environments.prepare", params, { service });
    expect(ok).toBe(false);
    expect(error).toMatchObject({ code: ErrorCodes.INVALID_REQUEST });
    expect(service.prepare).not.toHaveBeenCalled();
  });

  it("reports when no worker service is configured", async () => {
    expect(await callEnvironmentMethod("environments.prepare", request)).toEqual([
      false,
      undefined,
      { code: ErrorCodes.INVALID_REQUEST, message: "cloud worker environments are not configured" },
    ]);
  });

  it.each([
    { reused: false, revoked: false },
    { reused: true, revoked: false },
    { reused: false, revoked: true },
  ])(
    "revalidates the original source before preparation admission with reused=$reused revoked=$revoked",
    async ({ reused, revoked }) => {
      const result = { environmentId: "worker-1", preparationKey: "project-key", reused };
      const sourceController = new AbortController();
      const source = createAdmittedRunOperatorAuthority({
        profileId: "original-operator",
        scopes: ["operator.admin"],
        signal: sourceController.signal,
        assertCurrent: () => sourceController.signal.throwIfAborted(),
      });
      const preparing = createDeferredCore();
      const prepared = createDeferredCore();
      const admit = vi.fn(() => result);
      const prepare = vi.fn<TestWorkerService["prepare"]>(async (_request, authorize) => {
        authorize?.();
        preparing.resolve();
        await prepared.promise;
        authorize?.();
        return admit();
      });
      const respond = vi.fn();
      const options: GatewayRequestHandlerOptions = {
        req: {
          type: "req",
          id: "prepare-authority",
          method: "environments.prepare",
          params: request,
        },
        params: request,
        client: null,
        context: mockContext(workerService({ prepare })) as GatewayRequestContext,
        isWebchatConnect: () => false,
        respond,
        sessionMutationCommitGuard: source.assertCurrent,
      };
      const pending = environmentsHandlers["environments.prepare"]!(options);
      await preparing.promise;
      if (revoked) {
        sourceController.abort(new Error("Original operator source revoked"));
      }
      prepared.resolve();
      await pending;

      expect(prepare).toHaveBeenCalledExactlyOnceWith(request, expect.any(Function));
      if (revoked) {
        expect(admit).not.toHaveBeenCalled();
        expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, {
          code: ErrorCodes.UNAVAILABLE,
          message: "worker environment preparation failed",
        });
      } else {
        expect(admit).toHaveBeenCalledOnce();
        expect(respond).toHaveBeenCalledExactlyOnceWith(true, result, undefined);
      }
    },
  );

  it.each([
    ["profile_not_found", ErrorCodes.INVALID_REQUEST, "unknown worker profile"],
    ["invalid_profile", ErrorCodes.INVALID_REQUEST, "profile cannot prepare projects"],
    ["invalid_project", ErrorCodes.INVALID_REQUEST, "project must be a local Git checkout"],
    ["capacity", ErrorCodes.UNAVAILABLE, "prepared worker pool is full"],
  ])("preserves actionable %s errors", async (code, rpcCode, message) => {
    const service = workerService({
      prepare: vi.fn(async () => {
        throw new FakeWorkerServiceError(code, message);
      }),
    });
    expect(await callEnvironmentMethod("environments.prepare", request, { service })).toEqual([
      false,
      undefined,
      { code: rpcCode, message, details: { code } },
    ]);
  });

  it("hides unknown runtime failure details", async () => {
    const service = workerService({
      prepare: vi.fn(async () => {
        throw new FakeWorkerServiceError("provider_failure", "private endpoint details");
      }),
    });
    expect(await callEnvironmentMethod("environments.prepare", request, { service })).toEqual([
      false,
      undefined,
      { code: ErrorCodes.UNAVAILABLE, message: "worker environment preparation failed" },
    ]);
  });

  it("projects preparation identity without the durable demand or expiry fields", () => {
    const preparation = {
      purpose: "build" as const,
      key: "project-key",
      demandAtMs: 1_000,
      expiresAtMs: 60_000,
      consumedAtMs: null,
    };
    const summary = summarizeWorkerEnvironment(workerRecord({ preparation }));
    expect(summary.worker?.profileId).toBe("development");
    expect(summary.preparation).toEqual({
      purpose: "build",
      key: "project-key",
    });
    expect(summarizeWorkerEnvironment(workerRecord())).not.toHaveProperty("preparation");
  });
});
