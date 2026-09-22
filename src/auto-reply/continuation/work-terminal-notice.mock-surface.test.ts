// Belled rope for karmaterminal/openclaw#1361.
//
// `vi.mock` factories are an EXHAUSTIVE declaration of a module's surface for the
// test that declares them. Upstream-shared tests mock
// `infra/session-delivery-queue-runtime.js` with only the exports upstream's own
// graph needs. If continuation code reads an additional export from that module
// EAGERLY — at module evaluation rather than on call — every such shared test
// fails with
//
//   [vitest] No "<name>" export is defined on the "...session-delivery-queue-runtime.js" mock
//
// and the error names the mock rather than the importer, so it reads like a test
// bug rather than a fork divergence. It is invisible to typecheck, because the
// real module does export the symbol, and invisible in isolation, because the
// failing test never mentions continuation.
//
// This mocks that module with EXACTLY upstream's declared surface — copied from
// `src/gateway/server-runtime-services.delivery-recovery.test.ts`, which is
// byte-identical to upstream — and then imports the continuation module. Merely
// importing must not throw.
//
// If this file starts failing, someone has added an eager read of a new export
// from that module. The fix is to defer the ACCESS (a thunk that resolves on
// first call), not to widen the shared factory: a dynamic import of a mocked path
// is intercepted identically, so deferring the *import* alone changes nothing.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../infra/session-delivery-queue-runtime.js", () => ({
  // Upstream's surface, verbatim. Deliberately NOT extended.
  startSessionDeliveryRuntime: () => async () => {},
  schedulePendingSessionDeliveries: async () => {},
}));

describe("work-terminal-notice mock surface", () => {
  it("imports under upstream's session-delivery-queue-runtime mock surface", async () => {
    // The assertion is that this import resolves at all. An eager binding read of
    // an undeclared export rejects here.
    const mod = await import("./work-terminal-notice.js");
    expect(typeof mod).toBe("object");
  });

  it("does not read scheduleSessionDelivery from the mocked module at load time", async () => {
    const runtime = await import("../../infra/session-delivery-queue-runtime.js");
    // The mocked surface is exactly upstream's two exports; scheduleSessionDelivery
    // is absent on purpose. Importing the continuation module above must not have
    // required it.
    expect(Object.keys(runtime).toSorted()).toEqual([
      "schedulePendingSessionDeliveries",
      "startSessionDeliveryRuntime",
    ]);
  });
});
