/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { hoverDetails, renderPicker } from "./test-helpers/where-chip.ts";

describe("Where chip node tools", () => {
  it("offers explicit node tools when the runtime cannot host a session", () => {
    const onSelectNodeTools = vi.fn();
    const onSelectDevice = vi.fn();
    const container = renderPicker(
      true,
      undefined,
      {
        environments: [
          {
            id: "node:runner",
            type: "node",
            label: "Build runner",
            status: "available",
            sessionHost: true,
            invocableCommands: ["system.run"],
            requiredNodeCommand: { command: "runtime.exec", state: "undeclared" },
          },
        ],
        devicePlacement: { requiredNodeCommands: ["runtime.exec"], consumesWorkerSlot: false },
      },
      { onSelectNodeTools, onSelectDevice, nodeToolsSupported: true },
    );
    const row = container.querySelector<HTMLButtonElement>('[data-value="node-tools:runner"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("Node tools only");
    expect(row?.disabled).toBe(false);
    expect(hoverDetails(row)).toContain("No workspace is transferred");
    expect(hoverDetails(row)).toContain("Full-session hosting is unavailable");
    row?.click();
    expect(onSelectNodeTools).toHaveBeenCalledWith("runner");
    expect(onSelectDevice).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "read-only operator",
      isAdmin: false,
      status: "available",
      invocableCommands: ["system.run"],
    },
    {
      name: "offline node",
      isAdmin: true,
      status: "unavailable",
      invocableCommands: ["system.run"],
    },
    {
      name: "declared but unauthorized shell",
      isAdmin: true,
      status: "available",
      invocableCommands: [],
    },
  ])("does not offer direct access for $name", ({ isAdmin, status, invocableCommands }) => {
    const container = renderPicker(
      isAdmin,
      undefined,
      {
        environments: [
          {
            id: "node:runner",
            type: "node",
            label: "Build runner",
            status,
            sessionHost: false,
            capabilities: ["system.run"],
            invocableCommands,
          },
        ],
      },
      { onSelectNodeTools: vi.fn(), nodeToolsSupported: true },
    );
    expect(container.querySelector('[data-value="node-tools:runner"]')).toBeNull();
  });

  it.each([
    { reason: "Refreshing devices", nodeToolsSupported: true },
    {
      reason: "This model runtime cannot use node tools from the Gateway",
      nodeToolsSupported: false,
    },
  ])("keeps selected node intent disabled: $reason", ({ reason, nodeToolsSupported }) => {
    const onSelectNodeTools = vi.fn();
    const container = renderPicker(
      true,
      undefined,
      {
        execNode: "runner",
        environments: [
          {
            id: "node:runner",
            type: "node",
            label: "Build runner",
            status: "available",
            sessionHost: false,
            invocableCommands: ["system.run"],
          },
        ],
      },
      { onSelectNodeTools, nodeToolsDisabledReason: () => reason, nodeToolsSupported },
    );
    expect(container.querySelector("#new-session-where-trigger")?.textContent).toContain(
      "Node tools only",
    );
    const row = container.querySelector<HTMLButtonElement>('[data-value="node-tools:runner"]');
    expect(row?.getAttribute("aria-disabled")).toBe("true");
    expect(hoverDetails(row)).toContain(reason);
    row?.click();
    expect(onSelectNodeTools).not.toHaveBeenCalled();
  });

  it.each([false, undefined])(
    "requires runtime support before offering tools (%s)",
    (supported) => {
      const container = renderPicker(
        true,
        undefined,
        {
          environments: [
            {
              id: "node:runner",
              type: "node",
              label: "Build runner",
              status: "available",
              sessionHost: false,
              invocableCommands: ["system.run"],
            },
          ],
        },
        { onSelectNodeTools: vi.fn(), nodeToolsSupported: supported },
      );
      expect(container.querySelector('[data-value="node-tools:runner"]')).toBeNull();
    },
  );
});
