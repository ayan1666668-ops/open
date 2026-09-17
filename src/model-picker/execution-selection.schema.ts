import { z } from "zod";

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
