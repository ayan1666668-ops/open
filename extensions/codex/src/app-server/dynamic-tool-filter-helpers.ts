/** Retains the always-direct system agent after ordinary Codex profile filtering. */
export function preserveRingZeroSystemAgentTool<T extends { name: string; catalogMode?: string }>(
  allTools: T[],
  filteredTools: T[],
): T[] {
  const openclaw = allTools.find(
    (tool) => tool.name === "openclaw" && tool.catalogMode === "direct-only",
  );
  if (!openclaw) {
    return filteredTools;
  }
  return [openclaw, ...filteredTools.filter((tool) => tool.name !== "openclaw")];
}
