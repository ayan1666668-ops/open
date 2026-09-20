import { confirm, isCancel } from "@clack/prompts";
import { stylePromptMessage } from "../../../packages/terminal-core/src/prompt-style.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  checkShellCompletionStatus,
  ensureCompletionCacheExists,
} from "../../commands/doctor-completion.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";
import { CLI_NAME } from "../cli-name.js";
import { formatCliCommand } from "../command-format.js";
import { installCompletion } from "../completion-runtime.js";
import { tryWriteCompletionCache } from "./shared.js";

export async function tryInstallShellCompletion(opts: {
  root: string;
  jsonMode: boolean;
  skipPrompt: boolean;
}): Promise<void> {
  try {
    await tryWriteCompletionCache(opts.root, opts.jsonMode);
  } catch (err) {
    if (!opts.jsonMode) {
      const command = formatCliCommand("openclaw completion --write-state");
      defaultRuntime.log(
        theme.warn(
          `Completion cache update failed: ${formatErrorMessage(err)}. Update will continue; retry with: ${command}`,
        ),
      );
    }
  }
  if (opts.jsonMode || !process.stdin.isTTY) {
    return;
  }
  try {
    const status = await checkShellCompletionStatus(CLI_NAME);
    const generationOptions = { generationMode: "core-only" } as const;
    if (status.usesSlowPattern) {
      defaultRuntime.log(theme.muted("Upgrading shell completion to cached version..."));
      if (!(await ensureCompletionCacheExists(CLI_NAME, generationOptions))) {
        throw new Error("completion cache generation failed");
      }
      await installCompletion(status.shell, true, CLI_NAME);
      return;
    }
    if (status.profileInstalled && !status.cacheExists) {
      defaultRuntime.log(theme.muted("Regenerating shell completion cache..."));
      if (!(await ensureCompletionCacheExists(CLI_NAME, generationOptions))) {
        throw new Error("completion cache generation failed");
      }
      return;
    }
    if (!status.profileInstalled && !opts.skipPrompt) {
      defaultRuntime.log("");
      defaultRuntime.log(theme.heading("Shell completion"));
      const shouldInstall = await confirm({
        message: stylePromptMessage(`Enable ${status.shell} shell completion for ${CLI_NAME}?`),
        initialValue: true,
      });
      if (isCancel(shouldInstall) || !shouldInstall) {
        defaultRuntime.log(
          theme.muted(
            `Skipped. Run \`${formatCliCommand("openclaw completion --install")}\` later to enable.`,
          ),
        );
        return;
      }
      if (!(await ensureCompletionCacheExists(CLI_NAME, generationOptions))) {
        throw new Error("completion cache generation failed");
      }
      await installCompletion(status.shell, false, CLI_NAME);
    }
  } catch (err) {
    defaultRuntime.log(
      theme.warn(
        `Shell completion refresh failed: ${formatErrorMessage(err)}. Update will continue. Resolve the reported error before retrying: ${formatCliCommand("openclaw completion --write-state --install")}`,
      ),
    );
  }
}
