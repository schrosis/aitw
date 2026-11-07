import { z } from "zod";

/** Version of the intermediate representation format. */
export const intermediateVersion = 1;

const stepIdSchema = z.string().min(1);
const expressionMapSchema = z.record(z.string().min(1), z.string().min(1));

const transitionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("step"), step: stepIdSchema }),
  z.strictObject({ type: z.literal("end") }),
]);

const scriptStepSchema = z.strictObject({
  type: z.literal("script"),
  run: z.string().min(1),
  next: transitionSchema,
  timeoutMs: z.int().positive(),
  input: expressionMapSchema,
  output: expressionMapSchema,
});

/** Schema of the intermediate representation that the engine executes. */
export const intermediateSchema = z.strictObject({
  version: z.literal(intermediateVersion),
  start: stepIdSchema,
  steps: z.record(stepIdSchema, z.discriminatedUnion("type", [scriptStepSchema])),
});

/** A workflow in the intermediate representation. */
export type Intermediate = z.infer<typeof intermediateSchema>;

/** Where a workflow goes after a step. */
export type Transition = z.infer<typeof transitionSchema>;

/** A step in the intermediate representation. */
export type IntermediateStep = Intermediate["steps"][string];
