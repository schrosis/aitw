import { defineWaitMethod, definePlugin, inputDeclarationsSchema } from "@aitw/core";
import { z } from "zod";

/** Options of the `terminal` wait method, as the `with` field of a step writes them. */
const optionsSchema = z.strictObject({
  message: z.string().min(1).describe("Message that the terminal shows before asking"),
  schema: inputDeclarationsSchema
    .default({})
    .describe("Values to ask for. Without it, the step waits until Enter is pressed"),
});

/** Options of the `terminal` wait method. */
export type TerminalOptions = z.infer<typeof optionsSchema>;

/**
 * Waits for an answer that someone enters in the terminal of `aitw run`.
 *
 * The answers are the values that `schema` declares.
 */
export const terminalWaitMethod = defineWaitMethod({
  answers: ({ schema }) => schema,
  name: "terminal",
  with: optionsSchema,
});

/** The built-in plugin that provides the `terminal` wait method. */
export const terminalPlugin = definePlugin({
  name: "terminal",
  waitMethods: [terminalWaitMethod],
});
