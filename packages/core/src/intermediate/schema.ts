import { z } from "zod";

/** Version of the intermediate representation format. */
export const intermediateVersion = 1;

const stepIdSchema = z.string().min(1);
const inputNameSchema = z.string().min(1);
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

const inputBase = {
  description: z.string().optional(),
  required: z.boolean(),
};

// z.number() accepts only finite numbers.
const inputDeclarationSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("string"), ...inputBase, default: z.string().optional() }),
  z.strictObject({ type: z.literal("number"), ...inputBase, default: z.number().optional() }),
  z.strictObject({ type: z.literal("boolean"), ...inputBase, default: z.boolean().optional() }),
  z.strictObject({
    type: z.literal("choice"),
    ...inputBase,
    options: z.array(z.string().min(1)).min(1),
    default: z.string().optional(),
  }),
]);

/** Schema of the intermediate representation that the engine executes. */
export const intermediateSchema = z.strictObject({
  version: z.literal(intermediateVersion),
  input: z.record(inputNameSchema, inputDeclarationSchema),
  start: stepIdSchema,
  steps: z.record(stepIdSchema, z.discriminatedUnion("type", [scriptStepSchema])),
});

/** A workflow in the intermediate representation. */
export type Intermediate = z.infer<typeof intermediateSchema>;

/** Where a workflow goes after a step. */
export type Transition = z.infer<typeof transitionSchema>;

/** Declaration of a value that a workflow receives when it starts. */
export type InputDeclaration = z.infer<typeof inputDeclarationSchema>;

/** A step in the intermediate representation. */
export type IntermediateStep = Intermediate["steps"][string];
