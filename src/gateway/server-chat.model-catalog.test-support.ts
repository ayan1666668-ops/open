import type { GatewayModelCatalogSnapshot } from "./server-model-catalog.types.js";

export function createChatVisionModelCatalogSnapshot(): GatewayModelCatalogSnapshot {
  return {
    agentId: "main",
    agentDir: "/tmp/chat-attachment-vision-agent",
    catalogComplete: false,
    workspaceDir: "/tmp/chat-attachment-vision-workspace",
    config: {},
    entries: [
      {
        id: "vision-model",
        name: "Vision Model",
        provider: "test-provider",
        input: ["text", "image"],
      },
    ],
    routeVariants: [],
  };
}
