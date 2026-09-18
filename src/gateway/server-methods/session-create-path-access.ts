import path from "node:path";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
  type ErrorShape,
  type SessionsCreateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { resolveWorkspacePathContainment } from "./workspace-path-containment.js";

export async function authorizeSessionCreatePathAccess(params: {
  cfg: OpenClawConfig;
  cwd?: string;
  execNode?: string;
  permissionMode?: SessionsCreateParams["permissionMode"];
  clientScopes: readonly string[];
  trustedCaller: boolean;
}): Promise<Result<string | undefined, ErrorShape>> {
  // Agent tools expand `~` before RPC; the Gateway contract stays absolute-only.
  // Remote nodes may use Windows paths; local cwd must match the Gateway host.
  const cwdIsAbsolute =
    !params.cwd ||
    (params.execNode
      ? path.isAbsolute(params.cwd) || path.win32.isAbsolute(params.cwd)
      : path.isAbsolute(params.cwd));
  if (!cwdIsAbsolute) {
    return err(errorShape(ErrorCodes.INVALID_REQUEST, "sessions.create cwd must be absolute"));
  }
  if (
    params.permissionMode === "full" &&
    !params.trustedCaller &&
    !params.clientScopes.includes(ADMIN_SCOPE)
  ) {
    return err(
      missingScopeErrorShape({ missingScope: ADMIN_SCOPE, requiredScopes: [ADMIN_SCOPE] }),
    );
  }
  if (params.cwd && !params.execNode && !params.clientScopes.includes(ADMIN_SCOPE)) {
    const containment = await resolveWorkspacePathContainment(params.cwd, params.cfg);
    if (!containment) {
      return err(
        missingScopeErrorShape({
          missingScope: ADMIN_SCOPE,
          requiredScopes: [ADMIN_SCOPE],
        }),
      );
    }
    return ok(containment.path);
  }
  return ok(params.cwd);
}
