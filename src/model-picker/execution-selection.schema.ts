import { z } from "zod";
import type { ExecutionFallbackPermission } from "./execution-selection.js";

const identity = z.string().min(1);
const model = z.object({ provider: identity, id: identity }).strict();
const harness = z.object({ kind: z.literal("harness"), id: identity }).strict();
const cli = z.object({ kind: z.literal("cli"), id: identity }).strict();
const acp = z.object({ kind: z.literal("acp"), backend: identity, agent: identity }).strict();
const managed = z.literal("native-managed");
const pair = z.union([
  z.object({ model, executor: z.union([harness, cli]) }).strict(),
  z.object({ model: managed, executor: harness }).strict(),
  z
    .object({ model: z.union([z.object({ id: identity }).strict(), managed]), executor: acp })
    .strict(),
]);
const fallbackPermission = z.enum(["configured", "explicit"]);
const legacyRequest = z
  .object({
    provider: identity,
    source: z.enum(["auto", "user", "default"]).optional(),
  })
  .strict()
  .optional();
const deferredConstraints = {
  runtime: identity.optional(),
  executor: z.union([harness, cli, acp]).optional(),
};
export const sessionExecutionSelectionSchema = z.discriminatedUnion("state", [
  z
    .object({ state: z.literal("accepted"), selection: pair, fallbackPermission, legacyRequest })
    .strict(),
  z
    .object({
      state: z.literal("deferred"),
      request: z.union([
        z
          .object({
            ...deferredConstraints,
            model: z
              .union([z.object({ provider: identity.optional(), id: identity }).strict(), managed])
              .optional(),
          })
          .strict(),
        z
          .object({ ...deferredConstraints, defaultSelection: z.enum(["inherit", "configured"]) })
          .strict(),
      ]),
      fallbackPermission,
      previous: pair.optional(),
      legacyRequest,
    })
    .strict(),
]);

/** Recover authored intent, not the route that happened to serve an automatic fallback. */
export function resolveLegacyExecutionIntent(params: {
  model?: string;
  provider?: string;
  source?: unknown;
  originProvider?: string;
  originModel?: string;
}): {
  model: { provider?: string; id: string } | undefined;
  automatic: boolean;
  fallbackPermission: ExecutionFallbackPermission;
} {
  const automatic =
    params.source === "auto" ||
    params.source === "default" ||
    (params.source !== "user" && Boolean(params.originProvider && params.originModel));
  const requestedModel =
    automatic && params.originProvider && params.originModel
      ? { provider: params.originProvider, id: params.originModel }
      : params.model && params.source !== "default"
        ? { ...(params.provider ? { provider: params.provider } : {}), id: params.model }
        : undefined;
  return {
    model: requestedModel,
    automatic,
    fallbackPermission: (params.model || params.provider) && !automatic ? "explicit" : "configured",
  };
}
