# Railway Sandbox plugin

This extension provides three native tools for bounded Railway sandbox work:

- `railway_sandbox` creates, inspects, lists, and destroys one owned Railway sandbox operation.
- `railway_exec` runs a bounded command inside a recorded, owned sandbox.
- `railway_file` reads, writes, and lists bounded UTF-8 files inside the sandbox workspace.

## Configuration

Configure the plugin under `plugins.entries["railway-sandbox"].config`; do not use a global `railwaySandbox` key.

```json5
{
  plugins: {
    entries: {
      "railway-sandbox": {
        enabled: true,
        config: {
          environmentId: "8aa0d463-6035-4261-91ed-dbecef493e40",
          apiToken: { source: "store", id: "RAILWAY_API_TOKEN" },
          defaultIdleTimeoutMinutes: 6,
          maxIdleTimeoutMinutes: 10,
          defaultResources: { cpu: 1, memoryGB: 1 },
          maxResources: { cpu: 4, memoryGB: 8 },
          enforceAgents: ["main", "ada", "codeops", "editor", "writer"],
          enforceHeavyLocalExec: true,
          protectGeneratedPaths: true
        }
      }
    }
  }
}
```

`apiToken` is declared as a plugin `secretInputs` path, so the runtime receives the resolved value through the standard SecretRef materialization path. The plugin calls Railway's public GraphQL endpoint directly with `fetch`; it does not shell out to `railway api`, read ambient process environment credentials, or fall back to local execution.

## Custody and cleanup contract

- Global admission is atomic and fail-closed. One open operation covers `creating`, `running`, `create_uncertain`, `destroying`, and `cleanup_uncertain` until exact-ID destroy proof releases it.
- The owner agent and session recorded at create time must match later `status`, `exec`, `file`, and `destroy` calls.
- A create replay can reuse only the exact recorded running sandbox ID. It never adopts the newest sandbox and never retries after an uncertain create.
- Destroy success requires exact-ID terminal status or exact-ID absence plus completed active-inventory pagination. Contradictions remain `cleanup_uncertain` and keep custody blocked.
- File operations anchor paths to the sandbox workspace, preserve byte-exact UTF-8, and refuse truncated read output.

## Activation candidate procedure

1. Install or stage this extension from the reviewed source artifact for the OpenClaw `2026.9.3` host.
2. Configure `apiToken` as a SecretRef and `environmentId` for the allowed Railway environment.
3. Enable `enforceHeavyLocalExec` only for agents expected to use Railway for arbitrary code/build/test work.
4. Run focused regression tests for this package and one live exact-ID create/exec/file/destroy proof in a disposable Railway sandbox.
5. Do not activate in the five-seat runtime until the reviewed merge/deployment owner accepts the source and live evidence.
