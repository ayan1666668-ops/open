# Tool Pre-filter Plugin

A lightweight OpenClaw plugin that uses typed decision models (such as `typesafe-ai/jev`) to prune unneeded tool schemas before calling the primary conversational model.

## Why This Matters

Loading dozens of tool and skill definitions on every agent turn bloats the context window by 5,000–10,000 tokens, slows down model inference, and increases the likelihood of tool hallucinations.

When enabled, this plugin hooks into `before_prompt_build`:

- **Pure Conversation:** If the user's turn does not require external tools (probability below `thresholdAnyTool`), all tool schemas are pruned (`toolsAllow: []`), saving ~1,800+ tokens per turn.
- **Action Turns Preserved:** When tools are needed, tools are left unrestricted (`toolsAllow: undefined`).
- **Fail-open Resilience:** If the decision provider is unavailable, unconfigured, or times out, the plugin fails open without interrupting the conversation.

## Prerequisites & Setup

This plugin consumes OpenClaw's central Decision runtime (`api.runtime.decisions`). To enable evaluation:

1. **Configure a Decision Provider**:
   Enable and configure an authorized decision provider capability in OpenClaw, such as `vercel-ai-gateway` or `typesafe`.

2. **Select an Active Decision Model**:
   Set `decisionModel` globally or per-agent in `openclaw.json`:
   ```json
   {
     "agents": {
       "defaults": {
         "decisionModel": "typesafe-ai/jev"
       }
     }
   }
   ```

## Plugin Configuration

In `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "tool-prefilter": {
        "enabled": true,
        "config": {
          "thresholdAnyTool": 0.35,
          "timeoutMs": 500
        }
      }
    }
  }
}
```

### Options

| Option             | Type      | Default | Description                                           |
| :----------------- | :-------- | :------ | :---------------------------------------------------- |
| `enabled`          | `boolean` | `true`  | Whether the pre-filter hook is active.                |
| `thresholdAnyTool` | `number`  | `0.35`  | Tool probability cutoff below which tools are pruned. |
| `timeoutMs`        | `number`  | `500`   | Evaluation timeout deadline in milliseconds.          |
