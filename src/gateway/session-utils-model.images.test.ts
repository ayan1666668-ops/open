import { describe, test, expect, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayModelCatalogSnapshot } from "./server-model-catalog.types.js";
import { resolveGatewayModelSupportsImages } from "./session-utils-model.js";

describe("resolveGatewayModelSupportsImages", () => {
  const createModelCatalogSnapshot = (params: {
    agentId?: string;
    catalogComplete?: boolean;
    config?: OpenClawConfig;
    entries?: GatewayModelCatalogSnapshot["entries"];
    staticEntries?: GatewayModelCatalogSnapshot["staticEntries"];
  }): GatewayModelCatalogSnapshot => ({
    agentId: params.agentId ?? "main",
    agentDir: "/tmp/gateway-model-capability-agent",
    workspaceDir: "/tmp/gateway-model-capability-workspace",
    catalogComplete: params.catalogComplete ?? false,
    config: params.config ?? {},
    entries: params.entries ?? [],
    routeVariants: [],
    ...(params.staticEntries ? { staticEntries: params.staticEntries } : {}),
  });

  test("uses prepared Sol capabilities without starting full catalog discovery", async () => {
    const loadGatewayModelCatalog = vi.fn(async () => []);
    const preparedSnapshot = createModelCatalogSnapshot({
      agentId: "qa",
      staticEntries: [
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          provider: "openai",
          input: ["text", "image"],
        },
      ],
    });
    const loadGatewayModelCatalogSnapshot = vi.fn(async (params?: { readOnly?: boolean }) => {
      if (params?.readOnly !== true) {
        throw new Error("full catalog discovery must not start during attachment admission");
      }
      return preparedSnapshot;
    });

    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "gpt-5.6-sol",
        provider: "openai",
        loadGatewayModelCatalog,
        loadGatewayModelCatalogSnapshot,
      }),
    ).resolves.toBe(true);
    expect(loadGatewayModelCatalogSnapshot).toHaveBeenCalledWith({
      agentId: "qa",
      readOnly: true,
    });
    expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
  });

  test("falls back to live discovery for models absent from the prepared catalog", async () => {
    const loadGatewayModelCatalogSnapshot = vi.fn(async (params?: { readOnly?: boolean }) =>
      createModelCatalogSnapshot({
        agentId: "qa",
        entries: params?.readOnly
          ? []
          : [
              {
                id: "vendor/runtime-vision-model",
                name: "Runtime Vision Model",
                provider: "openrouter",
                input: ["text", "image"],
              },
            ],
      }),
    );

    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "vendor/runtime-vision-model",
        provider: "openrouter",
        loadGatewayModelCatalog: async () => [],
        loadGatewayModelCatalogSnapshot,
      }),
    ).resolves.toBe(true);
    expect(loadGatewayModelCatalogSnapshot).toHaveBeenNthCalledWith(1, {
      agentId: "qa",
      readOnly: true,
    });
    expect(loadGatewayModelCatalogSnapshot).toHaveBeenNthCalledWith(2, {
      agentId: "qa",
      readOnly: false,
    });
  });

  test("falls back to live discovery for provisional prepared text-only metadata", async () => {
    const loadGatewayModelCatalogSnapshot = vi.fn(async (params?: { readOnly?: boolean }) =>
      createModelCatalogSnapshot({
        agentId: "qa",
        entries: [
          {
            id: "vendor/runtime-vision-model",
            name: "Runtime Vision Model",
            provider: "openrouter",
            input: params?.readOnly ? ["text"] : ["text", "image"],
          },
        ],
      }),
    );

    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "vendor/runtime-vision-model",
        provider: "openrouter",
        loadGatewayModelCatalog: async () => [],
        loadGatewayModelCatalogSnapshot,
      }),
    ).resolves.toBe(true);
    expect(loadGatewayModelCatalogSnapshot).toHaveBeenNthCalledWith(1, {
      agentId: "qa",
      readOnly: true,
    });
    expect(loadGatewayModelCatalogSnapshot).toHaveBeenNthCalledWith(2, {
      agentId: "qa",
      readOnly: false,
    });
  });

  test("does not restart discovery for authoritative text-only metadata from a full owner", async () => {
    const catalogReadModes: Array<boolean | undefined> = [];
    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "vendor/runtime-text-model",
        provider: "openrouter",
        loadGatewayModelCatalog: async () => [],
        loadGatewayModelCatalogSnapshot: async (params) => {
          catalogReadModes.push(params?.readOnly);
          if (params?.readOnly !== true) {
            throw new Error("full catalog discovery must not restart for a complete owner");
          }
          return createModelCatalogSnapshot({
            agentId: "qa",
            catalogComplete: true,
            entries: [
              {
                id: "vendor/runtime-text-model",
                name: "Runtime Text Model",
                provider: "openrouter",
                input: ["text"],
              },
            ],
          });
        },
      }),
    ).resolves.toBe(false);
    expect(catalogReadModes).toEqual([true]);
  });

  test("does not restart discovery when a full owner authoritatively omits the model", async () => {
    const catalogReadModes: Array<boolean | undefined> = [];
    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "vendor/missing-model",
        provider: "openrouter",
        loadGatewayModelCatalog: async () => [],
        loadGatewayModelCatalogSnapshot: async (params) => {
          catalogReadModes.push(params?.readOnly);
          if (params?.readOnly !== true) {
            throw new Error("full catalog discovery must not restart for a complete owner");
          }
          return createModelCatalogSnapshot({
            agentId: "qa",
            catalogComplete: true,
            entries: [],
          });
        },
      }),
    ).resolves.toBe(false);
    expect(catalogReadModes).toEqual([true]);
  });

  test("repairs a stale visible text-only row with same-agent provider-static vision", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "gpt-5.4",
        provider: "openai",
        loadGatewayModelCatalog: async () => [],
        loadGatewayModelCatalogSnapshot: async () =>
          createModelCatalogSnapshot({
            agentId: "qa",
            entries: [{ id: "gpt-5.4", name: "Text only", provider: "openai", input: ["text"] }],
            staticEntries: [
              {
                id: "gpt-5.4",
                name: "GPT-5.4",
                provider: "openai",
                input: ["text", "image"],
              },
            ],
          }),
      }),
    ).resolves.toBe(true);
  });

  test("repairs missing visible input metadata with same-agent provider-static vision", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "gpt-5.4",
        provider: "openai",
        loadGatewayModelCatalog: async () => [],
        loadGatewayModelCatalogSnapshot: async () =>
          createModelCatalogSnapshot({
            agentId: "qa",
            entries: [{ id: "gpt-5.4", name: "Stale model", provider: "openai" }],
            staticEntries: [
              {
                id: "gpt-5.4",
                name: "GPT-5.4",
                provider: "openai",
                input: ["text", "image"],
              },
            ],
          }),
      }),
    ).resolves.toBe(true);
  });

  test("does not borrow another agent's provider-static image capabilities", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "gpt-5.4",
        provider: "openai",
        loadGatewayModelCatalog: async () => [],
        loadGatewayModelCatalogSnapshot: async () =>
          createModelCatalogSnapshot({
            agentId: "other",
            staticEntries: [
              {
                id: "gpt-5.4",
                name: "GPT-5.4",
                provider: "openai",
                input: ["text", "image"],
              },
            ],
          }),
      }),
    ).resolves.toBe(false);
  });

  test("does not override an explicitly configured text-only model with provider-static vision", async () => {
    const catalogReadModes: Array<boolean | undefined> = [];
    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "gpt-5.4",
        provider: "openai",
        loadGatewayModelCatalog: async () => [],
        loadGatewayModelCatalogSnapshot: async (params) => {
          catalogReadModes.push(params?.readOnly);
          return createModelCatalogSnapshot({
            agentId: "qa",
            config: {
              models: {
                providers: {
                  openai: {
                    baseUrl: "https://api.openai.com/v1",
                    models: [
                      {
                        id: "gpt-5.4",
                        name: "Text only",
                        reasoning: false,
                        input: ["text"],
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        contextWindow: 128_000,
                        maxTokens: 4_096,
                      },
                    ],
                  },
                },
              },
            },
            entries: [
              {
                id: "gpt-5.4",
                name: "Configured text only",
                provider: "openai",
                baseUrl: "https://api.openai.com/v1",
                input: ["text"],
              },
            ],
            staticEntries: [
              {
                id: "gpt-5.4",
                name: "GPT-5.4",
                provider: "openai",
                baseUrl: "https://api.openai.com/v1",
                input: ["text", "image"],
              },
            ],
          });
        },
      }),
    ).resolves.toBe(false);
    expect(catalogReadModes).toEqual([true]);
  });

  test("does not borrow provider-static image capabilities across configured routes", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "gpt-5.4",
        provider: "openai",
        loadGatewayModelCatalog: async () => [],
        loadGatewayModelCatalogSnapshot: async () =>
          createModelCatalogSnapshot({
            agentId: "qa",
            config: {
              models: {
                providers: {
                  openai: {
                    baseUrl: "https://custom.example.test/v1",
                    models: [],
                  },
                },
              },
            },
            staticEntries: [
              {
                id: "gpt-5.4",
                name: "GPT-5.4",
                provider: "openai",
                baseUrl: "https://api.openai.com/v1",
                input: ["text", "image"],
              },
            ],
          }),
      }),
    ).resolves.toBe(false);
  });

  test.each([
    {
      route: "API",
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
    },
    {
      route: "base URL",
      api: "openai-responses",
      baseUrl: "https://custom.example.test/v1",
    },
  ] as const)(
    "does not borrow provider-static vision across a mismatched visible $route",
    async ({ api, baseUrl }) => {
      await expect(
        resolveGatewayModelSupportsImages({
          agentId: "qa",
          model: "gpt-5.4",
          provider: "openai",
          loadGatewayModelCatalog: async () => [],
          loadGatewayModelCatalogSnapshot: async () =>
            createModelCatalogSnapshot({
              agentId: "qa",
              entries: [
                {
                  id: "gpt-5.4",
                  name: "Custom route",
                  provider: "openai",
                  api,
                  baseUrl,
                  input: ["text"],
                },
              ],
              staticEntries: [
                {
                  id: "gpt-5.4",
                  name: "GPT-5.4",
                  provider: "openai",
                  api: "openai-responses",
                  baseUrl: "https://api.openai.com/v1",
                  input: ["text", "image"],
                },
              ],
            }),
        }),
      ).resolves.toBe(false);
    },
  );

  test.each([
    {
      route: "visible API",
      visibleRoute: {
        api: "openai-completions" as const,
        baseUrl: "https://api.openai.com/v1",
      },
      configuredRoute: undefined,
      staticRoute: { baseUrl: "https://api.openai.com/v1" },
    },
    {
      route: "visible base URL",
      visibleRoute: {
        api: "openai-responses" as const,
        baseUrl: "https://custom.example.test/v1",
      },
      configuredRoute: undefined,
      staticRoute: { api: "openai-responses" as const },
    },
    {
      route: "configured API",
      visibleRoute: undefined,
      configuredRoute: {
        api: "openai-completions" as const,
        baseUrl: "https://api.openai.com/v1",
      },
      staticRoute: { baseUrl: "https://api.openai.com/v1" },
    },
    {
      route: "configured base URL",
      visibleRoute: undefined,
      configuredRoute: { baseUrl: "https://custom.example.test/v1" },
      staticRoute: { api: "openai-responses" as const },
    },
  ])(
    "does not borrow provider-static vision when its $route provenance is missing",
    async ({ visibleRoute, configuredRoute, staticRoute }) => {
      await expect(
        resolveGatewayModelSupportsImages({
          agentId: "qa",
          model: "gpt-5.4",
          provider: "openai",
          loadGatewayModelCatalog: async () => [],
          loadGatewayModelCatalogSnapshot: async () =>
            createModelCatalogSnapshot({
              ...(configuredRoute
                ? {
                    config: {
                      models: {
                        providers: {
                          openai: {
                            baseUrl: configuredRoute.baseUrl,
                            ...("api" in configuredRoute ? { api: configuredRoute.api } : {}),
                            models: [],
                          },
                        },
                      },
                    },
                  }
                : {}),
              agentId: "qa",
              entries: visibleRoute
                ? [
                    {
                      id: "gpt-5.4",
                      name: "Text only",
                      provider: "openai",
                      input: ["text"],
                      ...visibleRoute,
                    },
                  ]
                : [],
              staticEntries: [
                {
                  id: "gpt-5.4",
                  name: "GPT-5.4",
                  provider: "openai",
                  input: ["text", "image"],
                  ...staticRoute,
                },
              ],
            }),
        }),
      ).resolves.toBe(false);
    },
  );

  test("does not borrow provider-static image capabilities from another provider", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "gpt-5.4",
        provider: "openai",
        loadGatewayModelCatalog: async () => [],
        loadGatewayModelCatalogSnapshot: async () =>
          createModelCatalogSnapshot({
            agentId: "qa",
            staticEntries: [
              {
                id: "gpt-5.4",
                name: "Other provider vision",
                provider: "other",
                input: ["text", "image"],
              },
            ],
          }),
      }),
    ).resolves.toBe(false);
  });

  test("fails closed on providerless provider-static image capabilities", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "shared-vision",
        loadGatewayModelCatalog: async () => [],
        loadGatewayModelCatalogSnapshot: async () =>
          createModelCatalogSnapshot({
            agentId: "qa",
            staticEntries: [
              {
                id: "shared-vision",
                name: "First provider vision",
                provider: "first",
                input: ["text", "image"],
              },
              {
                id: "shared-vision",
                name: "Second provider vision",
                provider: "second",
                input: ["text", "image"],
              },
            ],
          }),
      }),
    ).resolves.toBe(false);
  });

  test("fails closed without using a stale catalog when the prepared snapshot fails", async () => {
    const loadGatewayModelCatalog = vi.fn(async () => [
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai",
        input: ["text", "image"] as ("text" | "image")[],
      },
    ]);

    await expect(
      resolveGatewayModelSupportsImages({
        agentId: "qa",
        model: "gpt-5.4",
        provider: "openai",
        loadGatewayModelCatalog,
        loadGatewayModelCatalogSnapshot: async () => {
          throw new Error("prepared catalog unavailable");
        },
      }),
    ).resolves.toBe(false);
    expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
  });

  test("keeps Foundry GPT deployments image-capable even when stale catalog metadata says text-only", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "gpt-5.4",
        provider: "microsoft-foundry",
        loadGatewayModelCatalog: async () => [
          { id: "gpt-5.4", name: "GPT-5.4", provider: "microsoft-foundry", input: ["text"] },
        ],
      }),
    ).resolves.toBe(true);
  });

  test("uses the preserved Foundry model name hint for alias deployments with stale text-only input metadata", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "deployment-gpt5",
        provider: "microsoft-foundry",
        loadGatewayModelCatalog: async () => [
          {
            id: "deployment-gpt5",
            name: "gpt-5.4",
            provider: "microsoft-foundry",
            input: ["text"],
          },
        ],
      }),
    ).resolves.toBe(true);
  });

  test("treats claude-cli Claude models as image-capable even when catalog metadata is stale or missing", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "claude-sonnet-4-6",
        provider: "claude-cli",
        loadGatewayModelCatalog: async () => [
          {
            id: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            provider: "claude-cli",
            input: ["text"],
          },
        ],
      }),
    ).resolves.toBe(true);
  });

  test("matches catalog model ids case-insensitively for explicit providers", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "Qwen/Qwen3.5-35B-A3B",
        provider: "modelscope",
        loadGatewayModelCatalog: async () => [
          {
            id: "qwen/qwen3.5-35b-a3b",
            name: "Qwen3.5 35B",
            provider: "modelscope",
            input: ["text", "image"],
          },
        ],
      }),
    ).resolves.toBe(true);
  });

  test("does not borrow image support from another provider when provider is explicit", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "gpt-4",
        provider: "openai",
        loadGatewayModelCatalog: async () => [
          { id: "gpt-4", name: "GPT-4", provider: "other", input: ["text", "image"] },
        ],
      }),
    ).resolves.toBe(false);
  });

  test("uses a unique providerless catalog match", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "Qwen/Qwen3.5-35B-A3B",
        loadGatewayModelCatalog: async () => [
          {
            id: "qwen/qwen3.5-35b-a3b",
            name: "Qwen3.5 35B",
            provider: "modelscope",
            input: ["text", "image"],
          },
        ],
      }),
    ).resolves.toBe(true);
  });

  test("fails closed on ambiguous providerless catalog matches", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "shared-vision",
        loadGatewayModelCatalog: async () => [
          { id: "shared-vision", name: "Shared Vision", provider: "first", input: ["text"] },
          {
            id: "shared-vision",
            name: "Shared Vision",
            provider: "second",
            input: ["text", "image"],
          },
        ],
      }),
    ).resolves.toBe(false);
  });
});
