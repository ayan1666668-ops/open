import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import * as ports from "../test-utils/ports.js";
import { reserveGatewayTestListener } from "./test-helpers.listener.js";

vi.mock("./server-runtime-state.js", () => ({
  createGatewayHttpTransport: async (params: { port: number; testListener?: Server }) =>
    params.testListener,
}));

function createTestTransport(transport: typeof import("./server-runtime-state.js"), port: number) {
  return transport.createGatewayHttpTransport({
    port,
  } as Parameters<typeof transport.createGatewayHttpTransport>[0]);
}

async function closeListener(listener: Server) {
  if (listener.listening) {
    await new Promise<void>((resolve, reject) => {
      listener.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function closeReservation(
  reservation: Awaited<ReturnType<typeof reserveGatewayTestListener>> | undefined,
) {
  if (reservation) {
    await closeListener(reservation.listener);
    await reservation.closeUnadopted();
  }
}

describe("reserved Gateway test listeners", () => {
  it("adopts a reservation after another listener occupies the first candidate", async () => {
    const transport = await import("./server-runtime-state.js");
    const competitor = createServer();
    const allocatePort = ports.getDeterministicFreePortBlock;
    let occupiedPort: number | undefined;
    const allocator = vi
      .spyOn(ports, "getDeterministicFreePortBlock")
      .mockImplementationOnce(async (options) => {
        occupiedPort = await allocatePort(options);
        await once(competitor.listen(occupiedPort, "127.0.0.1"), "listening");
        return occupiedPort;
      });
    let reservation: Awaited<ReturnType<typeof reserveGatewayTestListener>> | undefined;
    await runQaGatewayFixture(
      async () => {
        const acquired = await reserveGatewayTestListener();
        reservation = acquired;
        expect(competitor.listening).toBe(true);
        expect(acquired.port).not.toBe(occupiedPort);
        await expect(
          acquired.start(() => createTestTransport(transport, acquired.port)),
        ).resolves.toBe(acquired.listener);
        expect(acquired.listener.listening).toBe(true);
        console.info(
          "[gateway-port-reservation-proof]",
          JSON.stringify({
            competitorStillListening: competitor.listening,
            replacementSelected: acquired.port !== occupiedPort,
            replacementListenerListening: acquired.listener.listening,
          }),
        );
      },
      () => allocator.mockRestore(),
      () => closeListener(competitor),
      () => closeReservation(reservation),
    );
  });

  it("rejects an occupied requested port without choosing a replacement", async () => {
    const competitor = createServer();
    let reservation: Awaited<ReturnType<typeof reserveGatewayTestListener>> | undefined;
    await runQaGatewayFixture(
      async () => {
        const port = await ports.getDeterministicFreePortBlock({ offsets: [0, 1, 2, 3, 4] });
        await once(competitor.listen(port, "127.0.0.1"), "listening");
        const outcome = await reserveGatewayTestListener(port).then(
          (acquired) => (reservation = acquired),
          (error: unknown) => error,
        );
        expect(outcome).toMatchObject({ code: "EADDRINUSE" });
        expect(competitor.listening).toBe(true);
      },
      () => closeListener(competitor),
      () => closeReservation(reservation),
    );
  });

  it.each(["first", "second"] as const)(
    "adopts overlapping reservations when %s startup settles first",
    async (firstToSettle) => {
      const transport = await import("./server-runtime-state.js");
      const first = await reserveGatewayTestListener();
      const second = await reserveGatewayTestListener();
      const reservations = [first, second];
      const entered = reservations.map(() => createDeferred());
      const release = reservations.map(() => createDeferred());
      const runs = reservations.map((reservation, index) =>
        reservation.start(async () => {
          entered[index]!.resolve();
          await release[index]!.promise;
          return createTestTransport(transport, reservation.port);
        }),
      );
      // Observe both rejections immediately, including the pre-fix recursive spy failure.
      const settled = Promise.allSettled(runs);
      try {
        await Promise.race([
          Promise.all(entered.map(({ promise }) => promise)),
          ...runs.map(async (run) => {
            await run;
            throw new Error("Startup settled before both reservation callbacks entered");
          }),
        ]);
        const order = firstToSettle === "first" ? [0, 1] : [1, 0];
        for (const index of order) {
          release[index]!.resolve();
          await expect(runs[index]).resolves.toBe(reservations[index]!.listener);
        }
      } finally {
        release.forEach((gate) => gate.resolve());
        await settled;
        // The synthetic transport returns the listener but does not own its close.
        await Promise.all(
          reservations.map(async (reservation) => {
            await new Promise<void>((resolve, reject) => {
              const { listener } = reservation;
              listener.close((error) => (error ? reject(error) : resolve()));
            });
            await reservation.closeUnadopted();
          }),
        );
      }
    },
  );
});
