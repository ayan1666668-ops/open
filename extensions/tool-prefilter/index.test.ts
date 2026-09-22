import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import pluginEntry, { isRestrictiveToolPolicySupported } from "./index.js";

describe("tool-prefilter plugin", () => {
  it("registers before_prompt_build hook", () => {
    const registeredHooks: Record<string, Function> = {};
    const mockApi = {
      pluginConfig: { enabled: true },
      runtime: {
        decisions: {
          evaluate: vi.fn(),
        },
      },
      on: vi.fn((name: string, handler: Function) => {
        registeredHooks[name] = handler;
      }),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    };

    pluginEntry.register(mockApi as any);

    expect(mockApi.on).toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
    expect(registeredHooks.before_prompt_build).toBeDefined();
  });

  it("prunes all tools (returns toolsAllow: []) when pure conversation is detected from outcome.result.answers", async () => {
    let hookHandler: Function = () => {};
    const mockEvaluate = vi.fn().mockResolvedValue({
      status: "ok",
      result: {
        model: "typesafe-ai/jev",
        answers: {
          any_tool_needed: {
            type: "boolean",
            probabilityTrue: 0.08, // Very low probability -> pure conversation
          },
        },
      },
    });

    const mockApi = {
      pluginConfig: { enabled: true, thresholdAnyTool: 0.35 },
      config: {
        agents: {
          defaults: {
            decisionModel: "vercel-ai-gateway/typesafe-ai/jev",
          },
        },
      },
      runtime: {
        decisions: {
          evaluate: mockEvaluate,
        },
      },
      on: vi.fn((_name: string, handler: Function) => {
        hookHandler = handler;
      }),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    };

    pluginEntry.register(mockApi as any);

    const event = { currentUserMessage: "Hello, how are you today?" };
    const ctx = {
      agentId: "agent-1",
      modelProviderId: "anthropic",
      modelId: "claude-3-5-sonnet",
    };

    const result = await hookHandler(event, ctx);

    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ toolsAllow: [] });
    expect(mockApi.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Pure conversation detected"),
    );
  });

  it("leaves tools unconstrained when tools are needed", async () => {
    let hookHandler: Function = () => {};
    const mockEvaluate = vi.fn().mockResolvedValue({
      status: "ok",
      result: {
        model: "typesafe-ai/jev",
        answers: {
          any_tool_needed: {
            type: "boolean",
            probabilityTrue: 0.95, // High probability -> tools needed!
          },
        },
      },
    });

    const mockApi = {
      pluginConfig: { enabled: true, thresholdAnyTool: 0.35 },
      runtime: {
        decisions: {
          evaluate: mockEvaluate,
        },
      },
      on: vi.fn((_name: string, handler: Function) => {
        hookHandler = handler;
      }),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    };

    pluginEntry.register(mockApi as any);

    const event = { currentUserMessage: "Check git status and commit changes" };
    const ctx = { agentId: "agent-1" };

    const result = await hookHandler(event, ctx);

    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined(); // Does not restrict tools
  });

  it("distinguishes an explicitly empty currentUserMessage and does not classify prompt", async () => {
    let hookHandler: Function = () => {};
    const mockEvaluate = vi.fn();

    const mockApi = {
      pluginConfig: { enabled: true },
      runtime: {
        decisions: {
          evaluate: mockEvaluate,
        },
      },
      on: vi.fn((_name: string, handler: Function) => {
        hookHandler = handler;
      }),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    };

    pluginEntry.register(mockApi as any);

    // Explicitly empty message: must not fall back to classifying reconstructed history in prompt
    const event = { currentUserMessage: "", prompt: "Some older conversational context" };
    const ctx = { agentId: "agent-1" };

    const result = await hookHandler(event, ctx);

    expect(mockEvaluate).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("falls back to prompt when currentUserMessage is omitted", async () => {
    let hookHandler: Function = () => {};
    const mockEvaluate = vi.fn().mockResolvedValue({
      status: "ok",
      result: {
        model: "typesafe-ai/jev",
        answers: {
          any_tool_needed: {
            type: "boolean",
            probabilityTrue: 0.05,
          },
        },
      },
    });

    const mockApi = {
      pluginConfig: { enabled: true },
      config: {
        agents: {
          defaults: {
            decisionModel: "vercel-ai-gateway/typesafe-ai/jev",
          },
        },
      },
      runtime: {
        decisions: {
          evaluate: mockEvaluate,
        },
      },
      on: vi.fn((_name: string, handler: Function) => {
        hookHandler = handler;
      }),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    };

    pluginEntry.register(mockApi as any);

    // currentUserMessage is undefined (omitted legacy caller)
    const event = { prompt: "Just chatting with you" };
    const ctx = {
      agentId: "agent-1",
      modelProviderId: "anthropic",
      modelId: "claude-3-5-sonnet",
    };

    const result = await hookHandler(event, ctx);

    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    expect(mockEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        state: { userMessage: "Just chatting with you" },
      }),
      expect.anything(),
    );
    expect(result).toEqual({ toolsAllow: [] });
  });

  it("fails open gracefully when decision result is malformed or answers missing", async () => {
    let hookHandler: Function = () => {};
    const mockEvaluate = vi.fn().mockResolvedValue({
      status: "ok",
      result: {
        model: "typesafe-ai/jev",
        answers: {}, // Missing any_tool_needed
      },
    });

    const mockApi = {
      pluginConfig: { enabled: true },
      runtime: {
        decisions: {
          evaluate: mockEvaluate,
        },
      },
      on: vi.fn((_name: string, handler: Function) => {
        hookHandler = handler;
      }),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    };

    pluginEntry.register(mockApi as any);

    const event = { currentUserMessage: "Hello there" };
    const ctx = { agentId: "agent-1" };

    const result = await hookHandler(event, ctx);

    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined(); // Fails open
  });

  it("fails open gracefully on decision provider error without throwing", async () => {
    let hookHandler: Function = () => {};
    const mockEvaluate = vi.fn().mockRejectedValue(new Error("503 Service Unavailable"));

    const mockApi = {
      pluginConfig: { enabled: true },
      runtime: {
        decisions: {
          evaluate: mockEvaluate,
        },
      },
      on: vi.fn((_name: string, handler: Function) => {
        hookHandler = handler;
      }),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    };

    pluginEntry.register(mockApi as any);

    const event = { currentUserMessage: "Read the file foo.txt" };
    const ctx = { agentId: "agent-1" };

    const result = await hookHandler(event, ctx);

    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined(); // Fails open
    expect(mockApi.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Decision check failed, failing open"),
    );
  });

  describe("isRestrictiveToolPolicySupported helper", () => {
    it("preserves tools (returns false) when active runtime cannot be identified from unknown context", () => {
      expect(isRestrictiveToolPolicySupported()).toBe(false);
      expect(isRestrictiveToolPolicySupported({ agentId: "agent-1" })).toBe(false);
    });

    it("returns true for schema-valid documented embedded sessions without explicit runtime fields", () => {
      const documentedConfig = {
        agents: {
          defaults: {
            decisionModel: "vercel-ai-gateway/typesafe-ai/jev",
          },
        },
      };
      expect(
        isRestrictiveToolPolicySupported(
          { agentId: "main", modelProviderId: "anthropic", modelId: "claude-3-5-sonnet" },
          documentedConfig as any,
        ),
      ).toBe(true);
      expect(
        isRestrictiveToolPolicySupported(
          { agentId: "main", modelProviderId: "google", modelId: "gemini-1.5-pro" },
          documentedConfig as any,
        ),
      ).toBe(true);
      expect(
        isRestrictiveToolPolicySupported(
          { agentId: "main", modelProviderId: "ollama", modelId: "llama3" },
          documentedConfig as any,
        ),
      ).toBe(true);
    });

    it("returns false for implicit OpenAI sessions without explicit runtime policy", () => {
      const documentedConfig = {
        agents: {
          defaults: {
            decisionModel: "vercel-ai-gateway/typesafe-ai/jev",
          },
        },
      };
      expect(
        isRestrictiveToolPolicySupported(
          { agentId: "main", modelProviderId: "openai", modelId: "gpt-5.4" },
          documentedConfig as any,
        ),
      ).toBe(false);
    });

    it("returns true when agent config or explicit context specifies openclaw or copilot runtime", () => {
      expect(
        isRestrictiveToolPolicySupported({ agentId: "agent-1" }, {
          agents: { entries: { "agent-1": { agentRuntime: { id: "openclaw" } } } },
        } as any),
      ).toBe(true);
      expect(
        isRestrictiveToolPolicySupported({ agentId: "agent-1" }, {
          agents: { entries: { "agent-1": { agentRuntime: { id: "copilot" } } } },
        } as any),
      ).toBe(true);
      expect(isRestrictiveToolPolicySupported({ agentRuntimeId: "copilot" })).toBe(true);
      expect(isRestrictiveToolPolicySupported({ harnessId: "openclaw" })).toBe(true);
    });

    it("returns false when modelProviderId is codex or acpx", () => {
      expect(isRestrictiveToolPolicySupported({ modelProviderId: "codex" })).toBe(false);
      expect(isRestrictiveToolPolicySupported({ modelProviderId: "CODEX" })).toBe(false);
      expect(isRestrictiveToolPolicySupported({ modelProviderId: "acpx" })).toBe(false);
    });

    it("returns false when modelId references codex", () => {
      expect(isRestrictiveToolPolicySupported({ modelId: "gpt-5.4-codex" })).toBe(false);
      expect(isRestrictiveToolPolicySupported({ modelId: "codex/standard" })).toBe(false);
    });

    it("returns false when sessionKey indicates codex or acpx harness", () => {
      expect(
        isRestrictiveToolPolicySupported({
          sessionKey: "agent:main:harness:codex:node-session:123",
        }),
      ).toBe(false);
      expect(
        isRestrictiveToolPolicySupported({
          sessionKey: "agent:alpha:harness:codex:supervision:abc",
        }),
      ).toBe(false);
      expect(
        isRestrictiveToolPolicySupported({
          sessionKey: "harness:acpx:turn:1",
        }),
      ).toBe(false);
    });

    it("returns false when agent config specifies codex runtime", () => {
      const config = {
        agents: {
          entries: {
            "codex-agent": {
              agentRuntime: { id: "codex" },
            },
          },
        },
      } as any;
      expect(isRestrictiveToolPolicySupported({ agentId: "codex-agent" }, config)).toBe(false);
    });

    it("returns false when global defaults specify codex runtime", () => {
      const config = {
        agents: {
          defaults: {
            agentRuntime: { id: "codex" },
          },
        },
      } as any;
      expect(isRestrictiveToolPolicySupported({ agentId: "some-agent" }, config)).toBe(false);
    });

    it("returns false when explicit context specifies codex harness", () => {
      expect(isRestrictiveToolPolicySupported({ harnessId: "codex" })).toBe(false);
      expect(isRestrictiveToolPolicySupported({ agentHarnessId: "codex-app-server" })).toBe(false);
    });

    it("returns false when model-scoped defaults specify codex runtime via authoritative resolver", () => {
      const mockResolve = vi.fn().mockReturnValue({
        policy: { id: "codex" },
        source: "model",
      });
      const mockApi = {
        runtime: {
          modelConfig: {
            resolveModelRuntimePolicy: mockResolve,
          },
        },
      };
      expect(
        isRestrictiveToolPolicySupported(
          { modelProviderId: "openai", modelId: "gpt-5.4", agentId: "agent-1" },
          undefined,
          mockApi as any,
        ),
      ).toBe(false);
    });

    it("returns false for unknown harnesses to preserve tools when unknown", () => {
      expect(
        isRestrictiveToolPolicySupported({
          harnessId: "unknown-third-party-harness",
        }),
      ).toBe(false);
      expect(
        isRestrictiveToolPolicySupported({ agentId: "custom-agent" }, {
          agents: {
            entries: {
              "custom-agent": {
                agentRuntime: { id: "unknown-harness" },
              },
            },
          },
        } as any),
      ).toBe(false);
    });

    it("uses authoritative api.runtime.modelConfig.resolveModelRuntimePolicy when available", () => {
      const mockResolve = vi.fn().mockReturnValue({
        policy: { id: "codex" },
        source: "model",
      });
      const mockApi = {
        runtime: {
          modelConfig: {
            resolveModelRuntimePolicy: mockResolve,
          },
        },
      };

      const ctx = { modelProviderId: "openai", modelId: "gpt-5.4", agentId: "agent-1" };
      expect(isRestrictiveToolPolicySupported(ctx, undefined, mockApi as any)).toBe(false);
      expect(mockResolve).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "openai",
          modelId: "gpt-5.4",
          agentId: "agent-1",
        }),
      );
    });
  });

  describe("unsupported harness safety in before_prompt_build", () => {
    it("preserves tools (returns undefined) when pure conversation is detected on a Codex harness", async () => {
      let hookHandler: Function = () => {};
      const mockEvaluate = vi.fn().mockResolvedValue({
        status: "ok",
        result: {
          model: "typesafe-ai/jev",
          answers: {
            any_tool_needed: {
              type: "boolean",
              probabilityTrue: 0.05, // Pure conversation
            },
          },
        },
      });

      const mockApi = {
        pluginConfig: { enabled: true, thresholdAnyTool: 0.35 },
        runtime: {
          decisions: {
            evaluate: mockEvaluate,
          },
        },
        on: vi.fn((_name: string, handler: Function) => {
          hookHandler = handler;
        }),
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
        },
      };

      pluginEntry.register(mockApi as any);

      // A Codex-backed turn: e.g. modelProviderId: "codex"
      const event = { currentUserMessage: "What is the capital of France?" };
      const ctx = {
        agentId: "agent-codex",
        modelProviderId: "codex",
        sessionKey: "agent:main:harness:codex:node-session:123",
      };

      const result = await hookHandler(event, ctx);

      expect(mockEvaluate).toHaveBeenCalledTimes(1);
      expect(result).toBeUndefined(); // MUST NOT return { toolsAllow: [] }
      expect(mockApi.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("active harness does not support turn-scoped tool pruning"),
      );
    });

    it("preserves tools when pure conversation is detected for an agent configured with codex runtime", async () => {
      let hookHandler: Function = () => {};
      const mockEvaluate = vi.fn().mockResolvedValue({
        status: "ok",
        result: {
          model: "typesafe-ai/jev",
          answers: {
            any_tool_needed: {
              type: "boolean",
              probabilityTrue: 0.02,
            },
          },
        },
      });

      const mockApi = {
        pluginConfig: { enabled: true, thresholdAnyTool: 0.35 },
        config: {
          agents: {
            entries: {
              "codex-agent": {
                agentRuntime: { id: "codex" },
              },
            },
          },
        },
        runtime: {
          decisions: {
            evaluate: mockEvaluate,
          },
        },
        on: vi.fn((_name: string, handler: Function) => {
          hookHandler = handler;
        }),
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
        },
      };

      pluginEntry.register(mockApi as any);

      const event = { currentUserMessage: "Just saying hello" };
      const ctx = { agentId: "codex-agent" };

      const result = await hookHandler(event, ctx);

      expect(mockEvaluate).toHaveBeenCalledTimes(1);
      expect(result).toBeUndefined();
      expect(mockApi.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("active harness does not support turn-scoped tool pruning"),
      );
    });

    it("still prunes tools on supported copilot harness when pure conversation is detected", async () => {
      let hookHandler: Function = () => {};
      const mockEvaluate = vi.fn().mockResolvedValue({
        status: "ok",
        result: {
          model: "typesafe-ai/jev",
          answers: {
            any_tool_needed: {
              type: "boolean",
              probabilityTrue: 0.05,
            },
          },
        },
      });

      const mockApi = {
        pluginConfig: { enabled: true, thresholdAnyTool: 0.35 },
        config: {
          agents: {
            entries: {
              "copilot-agent": {
                agentRuntime: { id: "copilot" },
              },
            },
          },
        },
        runtime: {
          decisions: {
            evaluate: mockEvaluate,
          },
        },
        on: vi.fn((_name: string, handler: Function) => {
          hookHandler = handler;
        }),
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
        },
      };

      pluginEntry.register(mockApi as any);

      const event = { currentUserMessage: "Just saying hello" };
      const ctx = { agentId: "copilot-agent" };

      const result = await hookHandler(event, ctx);

      expect(mockEvaluate).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ toolsAllow: [] });
    });

    it("preserves tools on realistic Codex host context with model-scoped codex runtime in agents.defaults.models", async () => {
      let hookHandler: Function = () => {};
      const mockEvaluate = vi.fn().mockResolvedValue({
        status: "ok",
        result: {
          model: "typesafe-ai/jev",
          answers: {
            any_tool_needed: {
              type: "boolean",
              probabilityTrue: 0.04, // pure conversation turn
            },
          },
        },
      });

      const hostConfig = {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                agentRuntime: { id: "codex" },
              },
            },
          },
        },
      };

      const mockApi = {
        pluginConfig: { enabled: true, thresholdAnyTool: 0.35 },
        config: hostConfig,
        runtime: {
          decisions: {
            evaluate: mockEvaluate,
          },
          modelConfig: {
            resolveModelRuntimePolicy: vi.fn().mockReturnValue({
              policy: { id: "codex" },
              source: "model",
            }),
          },
        },
        on: vi.fn((_name: string, handler: Function) => {
          hookHandler = handler;
        }),
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
        },
      };

      pluginEntry.register(mockApi as any);

      // Exact realistic Codex attempt hookContext shape from extensions/codex/src/app-server/run-attempt-context.ts:107
      const event = { currentUserMessage: "What is 2 + 2?" };
      const ctx = {
        runId: "run-attempt-1",
        agentId: "default",
        sessionKey: "agent:default:main",
        sessionId: "session-abc-123",
        workspaceDir: "/repo/workspace",
        modelProviderId: "openai",
        modelId: "gpt-5.4",
        trigger: "user",
      };

      const result = await hookHandler(event, ctx);

      expect(mockEvaluate).toHaveBeenCalledTimes(1);
      expect(result).toBeUndefined(); // MUST preserve tools, avoiding Codex app-server rejection
      expect(mockApi.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("active harness does not support turn-scoped tool pruning"),
      );
    });

    it("prunes tools when ordinary openai/gpt-5.4 session is explicitly configured with openclaw runtime", async () => {
      let hookHandler: Function = () => {};
      const mockEvaluate = vi.fn().mockResolvedValue({
        status: "ok",
        result: {
          model: "typesafe-ai/jev",
          answers: {
            any_tool_needed: {
              type: "boolean",
              probabilityTrue: 0.04,
            },
          },
        },
      });

      const hostConfig = {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                agentRuntime: { id: "openclaw" },
              },
            },
          },
        },
      };

      const mockApi = {
        pluginConfig: { enabled: true, thresholdAnyTool: 0.35 },
        config: hostConfig,
        runtime: {
          decisions: {
            evaluate: mockEvaluate,
          },
          modelConfig: {
            resolveModelRuntimePolicy: vi.fn().mockReturnValue({
              policy: { id: "openclaw" },
              source: "model",
            }),
          },
        },
        on: vi.fn((_name: string, handler: Function) => {
          hookHandler = handler;
        }),
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
        },
      };

      pluginEntry.register(mockApi as any);

      const event = { currentUserMessage: "What is 2 + 2?" };
      const ctx = {
        runId: "run-attempt-2",
        agentId: "default",
        sessionKey: "agent:default:main",
        sessionId: "session-abc-456",
        workspaceDir: "/repo/workspace",
        modelProviderId: "openai",
        modelId: "gpt-5.4",
        trigger: "user",
      };

      const result = await hookHandler(event, ctx);

      expect(mockEvaluate).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ toolsAllow: [] });
    });

    it("preserves tools for native-owned Codex attempts where model identity is omitted even with unrelated wildcard policy", async () => {
      let hookHandler: Function = () => {};
      const mockEvaluate = vi.fn().mockResolvedValue({
        status: "ok",
        result: {
          model: "typesafe-ai/jev",
          answers: {
            any_tool_needed: {
              type: "boolean",
              probabilityTrue: 0.04,
            },
          },
        },
      });

      // Canonical plugin runtime mock containing real resolveModelRuntimePolicy
      const runtime = createPluginRuntimeMock();
      runtime.decisions.evaluate = mockEvaluate as any;

      // Configuration containing an unrelated provider-wildcard runtime policy
      const hostConfig = {
        agents: {
          defaults: {
            models: {
              "anthropic/*": {
                agentRuntime: { id: "openclaw" },
              },
            },
          },
        },
      };

      const mockApi = {
        pluginConfig: { enabled: true, thresholdAnyTool: 0.35 },
        config: hostConfig,
        runtime,
        on: vi.fn((_name: string, handler: Function) => {
          hookHandler = handler;
        }),
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
        },
      };

      pluginEntry.register(mockApi as any);

      // Native-owned Codex attempts omit modelProviderId and modelId when using supervision or preserveNativeModel
      const event = { currentUserMessage: "Hello from native-owned session" };
      const ctx = {
        runId: "run-attempt-native-1",
        agentId: "default",
        sessionKey: "agent:default:main",
        sessionId: "session-native-1",
        workspaceDir: "/repo/workspace",
        trigger: "user",
      };

      const result = await hookHandler(event, ctx);

      expect(mockEvaluate).toHaveBeenCalledTimes(1);
      expect(result).toBeUndefined(); // MUST preserve tools when runtime cannot be identified
      expect(mockApi.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("active harness does not support turn-scoped tool pruning"),
      );
      // Because model identity is omitted, resolveModelRuntimePolicy must not be called with missing model identity
      expect(runtime.modelConfig.resolveModelRuntimePolicy).not.toHaveBeenCalled();
    });

    it("prunes tools from a schema-valid documented embedded setup without legacy runtime fields", async () => {
      let hookHandler: Function = () => {};
      const mockEvaluate = vi.fn().mockResolvedValue({
        status: "ok",
        result: {
          model: "typesafe-ai/jev",
          answers: {
            any_tool_needed: {
              type: "boolean",
              probabilityTrue: 0.05,
            },
          },
        },
      });

      const runtime = createPluginRuntimeMock();
      runtime.decisions.evaluate = mockEvaluate as any;

      // Schema-valid documented configuration (no legacy agentRuntime)
      const hostConfig = {
        agents: {
          defaults: {
            decisionModel: "vercel-ai-gateway/typesafe-ai/jev",
          },
        },
      };

      const mockApi = {
        pluginConfig: { enabled: true, thresholdAnyTool: 0.35 },
        config: hostConfig,
        runtime,
        on: vi.fn((_name: string, handler: Function) => {
          hookHandler = handler;
        }),
        logger: {
          info: vi.fn(),
        },
      };

      pluginEntry.register(mockApi as any);

      const event = { currentUserMessage: "Tell me a joke" };
      const ctx = {
        runId: "run-embedded-1",
        agentId: "default",
        sessionKey: "agent:default:main",
        sessionId: "session-emb-1",
        workspaceDir: "/repo/workspace",
        modelProviderId: "anthropic",
        modelId: "claude-3-5-sonnet",
        trigger: "user",
      };

      const result = await hookHandler(event, ctx);

      expect(mockEvaluate).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ toolsAllow: [] }); // Prunes tools for embedded session!
      expect(mockApi.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Pure conversation detected"),
      );
    });

    it("honors canonical model-over-provider precedence through the registered hook", async () => {
      let hookHandler: Function = () => {};
      const mockEvaluate = vi.fn().mockResolvedValue({
        status: "ok",
        result: {
          model: "typesafe-ai/jev",
          answers: {
            any_tool_needed: {
              type: "boolean",
              probabilityTrue: 0.04,
            },
          },
        },
      });

      // Provider-level runtime is "codex", but model override is "openclaw".
      // The canonical resolveModelRuntimePolicy correctly resolves { policy: { id: "openclaw" }, source: "model" }.
      const mockResolve = vi.fn().mockReturnValue({
        policy: { id: "openclaw" },
        source: "model",
      });

      const mockApi = {
        pluginConfig: { enabled: true, thresholdAnyTool: 0.35 },
        config: {
          models: {
            providers: {
              custom: {
                agentRuntime: { id: "codex" },
                models: [{ id: "model-a", agentRuntime: { id: "openclaw" } }],
              },
            },
          },
        },
        runtime: {
          decisions: {
            evaluate: mockEvaluate,
          },
          modelConfig: {
            resolveModelRuntimePolicy: mockResolve,
          },
        },
        on: vi.fn((_name: string, handler: Function) => {
          hookHandler = handler;
        }),
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
        },
      };

      pluginEntry.register(mockApi as any);

      const event = { currentUserMessage: "Explain recursion" };
      const ctx = {
        agentId: "default",
        modelProviderId: "custom",
        modelId: "model-a",
      };

      const result = await hookHandler(event, ctx);

      expect(mockEvaluate).toHaveBeenCalledTimes(1);
      expect(mockResolve).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "custom",
          modelId: "model-a",
        }),
      );
      expect(result).toEqual({ toolsAllow: [] }); // Supported model override prunes tools!
    });

    it("honors canonical wildcard precedence through the registered hook", async () => {
      let hookHandler: Function = () => {};
      const mockEvaluate = vi.fn().mockResolvedValue({
        status: "ok",
        result: {
          model: "typesafe-ai/jev",
          answers: {
            any_tool_needed: {
              type: "boolean",
              probabilityTrue: 0.04,
            },
          },
        },
      });

      const mockResolve = vi.fn().mockReturnValue({
        policy: { id: "openclaw" },
        source: "provider",
      });

      const mockApi = {
        pluginConfig: { enabled: true, thresholdAnyTool: 0.35 },
        config: {},
        runtime: {
          decisions: {
            evaluate: mockEvaluate,
          },
          modelConfig: {
            resolveModelRuntimePolicy: mockResolve,
          },
        },
        on: vi.fn((_name: string, handler: Function) => {
          hookHandler = handler;
        }),
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
        },
      };

      pluginEntry.register(mockApi as any);

      const event = { currentUserMessage: "Explain recursion" };
      const ctx = {
        agentId: "default",
        modelProviderId: "custom",
        modelId: "model-wildcard-123",
      };

      const result = await hookHandler(event, ctx);

      expect(mockEvaluate).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ toolsAllow: [] });
    });
  });
});
