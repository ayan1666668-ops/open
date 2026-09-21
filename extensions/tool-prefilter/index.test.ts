import { describe, expect, it, vi } from "vitest";
import pluginEntry from "./index.js";

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
    const ctx = { agentId: "agent-1" };

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
    const ctx = { agentId: "agent-1" };

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
});
