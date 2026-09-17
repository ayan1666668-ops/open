import { describe, expect, it, vi } from "vitest";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { createAgentHarnessPromptToolPolicy } from "./harness/prompt-tool-policy.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import {
  applyToolSchemaDirectoryCatalog,
  applyToolSearchCatalog,
  buildToolSchemaDirectoryPrompt,
  createToolSearchCatalogRef,
  createToolSearchTools,
  registerHeadlessToolSearchCatalog,
  resolveToolSearchConfig,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

function fakeTool(name: string, description: string): AnyAgentTool {
  return {
    name,
    label: name,
    description,
    parameters: {
      type: "object",
      properties: {
        value: { type: "string" },
      },
    },
    execute: vi.fn(async (_toolCallId, input) => jsonResult({ name, input })),
  };
}

function pluginTool(name: string, description: string, pluginId = "fake-catalog"): AnyAgentTool {
  const tool = fakeTool(name, description);
  setPluginToolMeta(tool, {
    pluginId,
    optional: true,
  });
  return tool;
}

describe("Tool Search native core catalog", () => {
  it("keeps core coding tools visible without cataloging them", () => {
    const catalogRef = createToolSearchCatalogRef();
    const compacted = applyToolSearchCatalog({
      tools: [
        fakeTool(TOOL_SEARCH_RAW_TOOL_NAME, "search"),
        fakeTool(TOOL_DESCRIBE_RAW_TOOL_NAME, "describe"),
        fakeTool(TOOL_CALL_RAW_TOOL_NAME, "call"),
        fakeTool("read", "Read files"),
        fakeTool("edit", "Edit files"),
        fakeTool("exec", "Run shell"),
        pluginTool("fake_lookup", "Look up a record"),
      ],
      config: { tools: { toolSearch: { enabled: true, mode: "tools" } } } as never,
      catalogRef,
    });

    expect(compacted.tools.map((tool) => tool.name)).toEqual([
      TOOL_SEARCH_RAW_TOOL_NAME,
      TOOL_DESCRIBE_RAW_TOOL_NAME,
      TOOL_CALL_RAW_TOOL_NAME,
      "read",
      "edit",
      "exec",
    ]);
    expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual(["fake_lookup"]);
  });

  it("catalogs core coding tools in Tool Search code mode", () => {
    const catalogRef = createToolSearchCatalogRef();
    const compacted = applyToolSearchCatalog({
      tools: [
        fakeTool(TOOL_SEARCH_CODE_MODE_TOOL_NAME, "code mode"),
        fakeTool(TOOL_SEARCH_RAW_TOOL_NAME, "search"),
        fakeTool("read", "Read files"),
        fakeTool("exec", "Run shell"),
        pluginTool("fake_lookup", "Look up a record"),
      ],
      config: { tools: { toolSearch: { enabled: true, mode: "code" } } } as never,
      catalogRef,
    });

    expect(compacted.tools.map((tool) => tool.name)).toEqual([TOOL_SEARCH_CODE_MODE_TOOL_NAME]);
    expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual([
      "exec",
      "read",
      "fake_lookup",
    ]);
  });

  it("catalogs core coding tools in headless catalogs", () => {
    const catalogRef = createToolSearchCatalogRef();
    registerHeadlessToolSearchCatalog({
      catalogRef,
      tools: [
        fakeTool("read", "Read files"),
        fakeTool("exec", "Run shell"),
        pluginTool("fake_lookup", "Look up a record"),
      ],
    });

    expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual([
      "exec",
      "read",
      "fake_lookup",
    ]);
  });

  it("names only the core coding tools still visible after policy filtering", () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = { tools: { toolSearch: { enabled: true, mode: "tools" } } } as never;
    applyToolSearchCatalog({
      tools: [
        fakeTool(TOOL_SEARCH_RAW_TOOL_NAME, "search"),
        fakeTool(TOOL_DESCRIBE_RAW_TOOL_NAME, "describe"),
        fakeTool(TOOL_CALL_RAW_TOOL_NAME, "call"),
        fakeTool("read", "Read a file"),
        pluginTool("fake_weather", "Read current weather"),
      ],
      config,
      catalogRef,
    });
    const directory = buildToolSchemaDirectoryPrompt({ config, catalogRef });
    expect(directory).toContain("Call read directly.");
    expect(directory).not.toContain("exec");
    expect(directory).not.toContain("apply_patch");
    expect(directory).not.toContain("process");
  });

  it("keeps Call read directly when the deferred catalog is empty", () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = { tools: { toolSearch: { enabled: true, mode: "tools" } } } as never;
    applyToolSearchCatalog({
      tools: [
        fakeTool(TOOL_SEARCH_RAW_TOOL_NAME, "search"),
        fakeTool(TOOL_DESCRIBE_RAW_TOOL_NAME, "describe"),
        fakeTool(TOOL_CALL_RAW_TOOL_NAME, "call"),
        fakeTool("read", "Read a file"),
      ],
      config,
      catalogRef,
    });
    expect(catalogRef.current?.entries ?? []).toEqual([]);
    const directory = buildToolSchemaDirectoryPrompt({ config, catalogRef });
    expect(directory).toContain("Available deferred-schema tools: none.");
    expect(directory).toContain("Call read directly.");
    expect(directory).not.toContain("exec");
  });

  it("omits direct-call guidance when no core coding tools are visible", () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = { tools: { toolSearch: { enabled: true, mode: "tools" } } } as never;
    applyToolSearchCatalog({
      tools: [
        fakeTool(TOOL_SEARCH_RAW_TOOL_NAME, "search"),
        fakeTool(TOOL_DESCRIBE_RAW_TOOL_NAME, "describe"),
        fakeTool(TOOL_CALL_RAW_TOOL_NAME, "call"),
        pluginTool("fake_weather", "Read current weather"),
      ],
      config,
      catalogRef,
    });
    const directory = buildToolSchemaDirectoryPrompt({ config, catalogRef });
    expect(directory).not.toContain("Call read");
    expect(directory).not.toContain("apply_patch");
    expect(directory).toContain("Use tool_search for a compact input signature or tool_describe");
  });

  it.each(["tools", "directory"] as const)(
    "lists only deferred tools while keeping native core calls resolvable in %s mode",
    async (mode) => {
      const catalogRef = createToolSearchCatalogRef();
      const config = { tools: { toolSearch: { enabled: true, mode } } };
      const read = fakeTool("read", "Read a workspace file");
      const status = fakeTool("session_status", "Inspect the current session");
      const tools = [...createToolSearchTools({ config, catalogRef }), read, status];
      const apply = mode === "directory" ? applyToolSchemaDirectoryCatalog : applyToolSearchCatalog;
      const ctx = { config, catalogRef };
      const first = apply({ ...ctx, tools });
      expect(first.tools).toContain(read);
      expect(first.tools).not.toContain(status);
      expect(buildToolSchemaDirectoryPrompt(ctx)).not.toContain("- read (core)");
      expect(buildToolSchemaDirectoryPrompt(ctx)).toContain("- session_status (core)");
      const runtime = new ToolSearchRuntime(ctx, resolveToolSearchConfig(config));
      // Trusted core read stays native, so the deferred catalog does not list it.
      expect(await runtime.search("read", { limit: 1 })).toEqual([]);
      expect(await runtime.call("openclaw:core:read", { value: "file.txt" })).toEqual(
        expect.objectContaining({
          result: expect.objectContaining({
            details: { name: "read", input: { value: "file.txt" } },
          }),
        }),
      );

      // Same tools, different native surface: a cached deferred row must disappear.
      const direct = apply({ ...ctx, tools, directToolNames: ["session_status"] });
      expect(direct.tools).toContain(status);
      const emptied = buildToolSchemaDirectoryPrompt(ctx);
      expect(emptied).toContain("Available deferred-schema tools: none.");
      expect(emptied).toContain("Call read directly.");
      apply({ ...ctx, tools });
      expect(buildToolSchemaDirectoryPrompt(ctx)).toContain("- session_status (core)");

      const lookalike = pluginTool("read", "Unrelated plugin reader");
      apply({ ...ctx, tools: [...tools, lookalike] });
      expect(buildToolSchemaDirectoryPrompt(ctx)).not.toContain("- read (");
      expect(await runtime.search("read", { limit: 5 })).toEqual([
        expect.objectContaining({ name: "read", sourceName: "fake-catalog" }),
      ]);
    },
  );

  it("rejects tool_call for a core tool excluded by the prompt policy", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = { tools: { toolSearch: { enabled: true, mode: "tools" } } } as never;
    const execTool = fakeTool("exec", "Run a command");
    const readTool = fakeTool("read", "Read a file");
    const compacted = applyToolSearchCatalog({
      tools: [
        fakeTool(TOOL_SEARCH_RAW_TOOL_NAME, "search"),
        fakeTool(TOOL_DESCRIBE_RAW_TOOL_NAME, "describe"),
        fakeTool(TOOL_CALL_RAW_TOOL_NAME, "call"),
        readTool,
        execTool,
        pluginTool("fake_weather", "Read current weather"),
      ],
      config,
      catalogRef,
    });
    expect(catalogRef.current?.directCoreToolNames).toEqual(["read", "exec"]);

    const policy = createAgentHarnessPromptToolPolicy({
      tools: compacted.tools,
      catalogRef,
      codeModeControlsEnabled: false,
    });
    policy.apply({ toolsAllow: ["read"] });
    expect(catalogRef.current?.directCoreToolNames).toEqual(["read"]);

    const runtime = new ToolSearchRuntime({ catalogRef, config }, resolveToolSearchConfig(config));
    await expect(runtime.call("exec", { command: "true" })).rejects.toThrow(
      "Unavailable in this run",
    );
    expect(execTool.execute).not.toHaveBeenCalled();

    policy.apply();
    expect(catalogRef.current?.directCoreToolNames).toEqual(["read", "exec"]);
    await runtime.call("exec", { command: "true" });
    expect(execTool.execute).toHaveBeenCalledOnce();
  });
});
