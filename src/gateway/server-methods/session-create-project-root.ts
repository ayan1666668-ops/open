import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  ProjectCheckoutError,
  resolveProjectCheckout,
  resolveProjectDirectory,
  resolveProjectRegistry,
} from "../../projects/project-registry.js";

export async function resolveSessionCreateProjectRoot(
  cfg: OpenClawConfig,
  projectId: string,
  worktree?: boolean,
): Promise<Result<string, ErrorShape>> {
  const project = resolveProjectRegistry(cfg, projectId);
  if (!project) {
    return err(errorShape(ErrorCodes.INVALID_REQUEST, `unknown project id: ${projectId}`));
  }
  try {
    const checkout = worktree === true ? await resolveProjectCheckout(project.repoRoot) : undefined;
    const projectRoot = checkout?.path ?? (await resolveProjectDirectory(project.repoRoot));
    if (checkout && project.source !== "workspace" && checkout.path !== checkout.repoRoot) {
      throw new ProjectCheckoutError(`project root is no longer a git checkout`);
    }
    return ok(projectRoot);
  } catch (error) {
    const detail =
      error instanceof ProjectCheckoutError ? error.message : formatErrorMessage(error);
    return err(
      errorShape(
        ErrorCodes.UNAVAILABLE,
        `project ${projectId} is unavailable (${detail}); update the agent workspace path or re-register the project`,
      ),
    );
  }
}
