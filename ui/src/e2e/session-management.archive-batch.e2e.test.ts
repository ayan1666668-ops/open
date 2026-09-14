import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  activateSelfRemovingControl,
  captureUiProof,
  controlUiSessionPath,
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const rosterMatch = { includeGlobal: true };

suite.define(() => {
  it.each(["refreshed", "failed refresh", "Undo without restore events"] as const)(
    "reconciles batch archive acknowledgements with %s",
    async (scenario) => {
      const context = await suite.browser.newContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
      const batchKeys = ["agent:main:batch-a", "agent:main:batch-b", "agent:main:batch-c"] as const;
      const batchRows = [
        sessionRow(batchKeys[0], "Batch A", baseTime - 1_000),
        sessionRow(batchKeys[1], "Batch B", baseTime - 2_000, {
          hasActiveRun: true,
          status: "running",
        }),
        sessionRow(batchKeys[2], "Batch C", baseTime - 3_000),
      ];
      const gateway = await installMockGateway(page, {
        deferredMethods: ["sessions.patchMany"],
        methodResponses: {
          "sessions.list": sessionsListResponse([
            sessionRow("agent:main:main", "Main", baseTime),
            ...batchRows,
          ]),
          "sessions.patchMany": {
            outcomes: batchKeys.map((key) => ({ ok: true, key, agentId: "main" })),
          },
        },
        sessionArchiveFiltering: true,
        sessionKey: "agent:main:main",
      });

      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        const sidebar = page.locator("openclaw-app-sidebar");
        const rowFor = (key: string) =>
          sidebar.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
        await rowFor(batchKeys[0]).waitFor({ state: "visible", timeout: 10_000 });
        for (const key of batchKeys.slice(1)) {
          await rowFor(key).waitFor({ state: "visible" });
        }
        const listCountBeforeBatch = (await gateway.getRequests("sessions.list", rosterMatch))
          .length;

        for (const key of batchKeys) {
          await rowFor(key).click({ modifiers: ["Alt"] });
        }
        await rowFor(batchKeys[0]).click({ button: "right" });
        const batchMenu = page.locator("openclaw-session-menu");
        const archiveItem = batchMenu.getByRole("menuitem", {
          name: `Archive ${batchKeys.length}`,
        });
        await archiveItem.waitFor({ state: "visible", timeout: 10_000 });
        expect(await archiveItem.isDisabled()).toBe(false);
        expect(
          await batchMenu
            .getByRole("menuitem", { name: `Delete ${batchKeys.length}…` })
            .isDisabled(),
        ).toBe(true);
        await captureUiProof(suite, page, "sidebar-multi-select-archive-menu.png");
        await page.keyboard.press("A");

        const patchMany = await gateway.waitForRequest("sessions.patchMany");
        for (const key of batchKeys) {
          await rowFor(key).getByRole("status").filter({ hasText: "Archiving…" }).waitFor();
        }
        await rowFor(batchKeys[0]).click({ button: "right" });
        const pendingAction = batchMenu.getByRole("menuitem", { name: "Archiving…", exact: true });
        await pendingAction.waitFor();
        expect(await pendingAction.isDisabled()).toBe(true);
        await page.keyboard.press("Escape");
        if (scenario !== "refreshed") {
          await gateway.deferNext("sessions.list", rosterMatch);
        }
        await gateway.resolveDeferred("sessions.patchMany");
        const patchManyParams = requireRecord(patchMany.params);
        expect(patchManyParams.patch).toEqual({ archived: true });
        expect(patchManyParams.targets).toEqual(
          batchKeys.map((key) => ({
            key,
            agentId: "main",
            expectedSessionId: `session:${key}`,
          })),
        );
        expect(await gateway.getRequests("sessions.patch")).toEqual([]);
        expect(await gateway.getRequests("sessions.abort")).toEqual([]);
        expect(await gateway.getRequests("agent.wait")).toEqual([]);
        await expect
          .poll(async () => (await gateway.getRequests("sessions.list", rosterMatch)).length, {
            timeout: 10_000,
          })
          .toBe(listCountBeforeBatch + 1);
        if (scenario === "failed refresh") {
          await gateway.rejectDeferred("sessions.list", {
            code: "UNAVAILABLE",
            message: "Archive list refresh unavailable",
          });
        } else if (scenario === "Undo without restore events") {
          // These committed events arrive while the original rows are still held.
          // Undo must retire their confirmation even if its own events are dropped.
          const archivedAt = Date.now();
          for (const row of batchRows) {
            await gateway.emitGatewayEvent("sessions.changed", {
              ...row,
              archived: true,
              archivedAt,
              updatedAt: archivedAt,
              sessionKey: row.key,
              reason: "patch",
            });
          }
          await gateway.resolveDeferred("sessions.list");
        }
        const toast = page.locator(".app-toast");
        await expect.poll(() => toast.textContent()).toContain("Archived 3 sessions");
        if (scenario === "failed refresh") {
          await captureUiProof(suite, page, "batch-archive-failed-readback.png");
        }
        for (const key of batchKeys) {
          await expect.poll(() => rowFor(key).count()).toBe(0);
        }
        if (scenario === "failed refresh") {
          await expect
            .poll(() => page.locator("[data-sidebar-session-error]").textContent())
            .toContain("Archive list refresh unavailable");
        } else {
          await expect.poll(() => page.locator("[data-sidebar-session-error]").count()).toBe(0);
        }
        await captureUiProof(suite, page, "sidebar-multi-select-archive-settled.png");
        if (scenario === "refreshed") {
          await page.waitForTimeout(500);
          expect((await gateway.getRequests("sessions.list", rosterMatch)).length).toBe(
            listCountBeforeBatch + 1,
          );
        } else if (scenario === "Undo without restore events") {
          await activateSelfRemovingControl(
            toast.getByRole("button", { name: "Undo", exact: true }),
          );
          const undo = await gateway.waitForRequest("sessions.patchMany", { after: 1 });
          expect(requireRecord(undo.params)).toEqual({
            targets: patchManyParams.targets,
            patch: { archived: false },
          });
          try {
            for (const key of batchKeys) {
              await expect.poll(() => rowFor(key).count()).toBe(1);
            }
            expect(new URL(page.url()).pathname).toBe(controlUiSessionPath("agent:main:main"));
          } finally {
            await captureUiProof(suite, page, "batch-archive-undo-without-events.png");
          }
        }
      } finally {
        await context.close();
      }
    },
  );
});
