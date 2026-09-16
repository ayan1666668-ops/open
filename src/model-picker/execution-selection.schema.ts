import { z } from "zod";
import type { SessionExecutionSelection } from "./execution-selection.js";

const identity = z.string().min(1);
const model = z.object({ provider: identity, id: identity }).strict();
const harness = z.object({ kind: z.literal("harness"), id: identity }).strict();
const cli = z.object({ kind: z.literal("cli"), id: identity }).strict();
const acp = z.object({ kind: z.literal("acp"), backend: identity, agent: identity }).strict();
const managed = z.literal("native-managed");
const pair = z.union([
  z.object({ model: z.union([model, managed]), executor: harness }).strict(),
  z.object({ model, executor: cli }).strict(),
  z
    .object({ model: z.union([z.object({ id: identity }).strict(), managed]), executor: acp })
    .strict(),
]);
const fallbackPermission = z.enum(["configured", "explicit"]);
export const sessionExecutionSelectionSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("accepted"), selection: pair, fallbackPermission }).strict(),
  z
    .object({
      state: z.literal("deferred"),
      request: z
        .object({
          model: z
            .union([z.object({ provider: identity.optional(), id: identity }).strict(), managed])
            .optional(),
          runtime: identity.optional(),
          executor: z.union([harness, cli, acp]).optional(),
        })
        .strict(),
      fallbackPermission,
      previous: pair.optional(),
    })
    .strict(),
]);

export function parseSessionExecutionSelection(value: unknown): SessionExecutionSelection {
  return sessionExecutionSelectionSchema.parse(value);
}
