// Railway sandbox plugin entrypoint registers remote execution tools and local heavy-work policy.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createRailwayExecTool, createRailwayFileTool, createRailwaySandboxTool } from "./src/tools.js";
import { evaluateHeavyLocalWorkBoundary } from "./src/policy.js";

export default definePluginEntry({
  id: "railway-sandbox",
  name: "Railway Sandbox",
  description: "Railway sandbox execution tools with Gateway heavy-work boundary enforcement.",
  register(api) {
    api.registerTool((ctx) => createRailwaySandboxTool(api, ctx), { name: "railway_sandbox" });
    api.registerTool((ctx) => createRailwayExecTool(api, ctx), { name: "railway_exec" });
    api.registerTool((ctx) => createRailwayFileTool(api, ctx), { name: "railway_file" });
    api.registerTrustedToolPolicy({
      id: "heavy-local-work-boundary",
      description:
        "Blocks configured agents from running dependency/build/test work on Gateway-local hosts when Railway remote execution is required.",
      matcher: ["exec", "write", "edit", "apply_patch"],
      evaluate: (event, ctx) => evaluateHeavyLocalWorkBoundary(api, event, ctx),
    });
  },
});
