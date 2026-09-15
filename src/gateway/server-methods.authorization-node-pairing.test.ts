import { describe, expect, it, vi } from "vitest";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/shared-types.js";

describe("gateway node pairing fence guards", () => {
  it("rejects node RPCs without a connId without touching the registry", async () => {
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));
    const respond = vi.fn();
    const isConnectionCurrentPairingState = vi.fn().mockResolvedValue(true);
    const invalidateConnectionForPairingChange = vi.fn().mockReturnValue(false);

    await handleGatewayRequest({
      req: { type: "req", id: "req-node-no-conn", method: "node.event", params: { event: "test" } },
      respond,
      client: {
        connect: {
          role: "node",
          scopes: [],
          device: {
            id: "node-no-conn",
            publicKey: "public-key",
            signature: "signature",
            signedAt: 1,
            nonce: "nonce",
          },
          client: { id: "node-host", version: "1", platform: "test", mode: "node" },
          minProtocol: 1,
          maxProtocol: 1,
        },
      } as Parameters<typeof handleGatewayRequest>[0]["client"],
      isWebchatConnect: () => false,
      context: {
        logGateway: { warn: vi.fn() },
        nodeRegistry: { isConnectionCurrentPairingState, invalidateConnectionForPairingChange },
      } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
      extraHandlers: { "node.event": handler },
    });

    expect(isConnectionCurrentPairingState).not.toHaveBeenCalled();
    expect(invalidateConnectionForPairingChange).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        details: { code: "PAIRING_CHANGED" },
      }),
    );
  });
});
