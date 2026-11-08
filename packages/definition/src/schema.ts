import { identifierPattern, identifierSource } from "@aitw/core";
import { z } from "zod";

const stepIdPattern = new RegExp(`^(?!end$)${identifierSource}$`, "u");
const durationPattern = /^[1-9][0-9]*(?:s|m|h)$/u;

/** Definition format version supported by this package. */
export const definitionVersion = "v0.1";

/** Timeout applied to a script step that does not specify one. */
export const defaultStepTimeout = "30m";

const identifierSchema = z
  .string()
  .regex(identifierPattern, "Must start with a letter and contain only letters, digits, or _");

const stepIdSchema = z
  .string()
  .regex(
    stepIdPattern,
    "Must start with a letter, contain only letters, digits, or _, and not be the reserved word end",
  );

const expressionMapSchema = z.record(identifierSchema, z.string().min(1));

const scriptStepSchema = z.strictObject({
  type: z.literal("script"),
  run: z.string().min(1),
  next: identifierSchema,
  timeout: z
    .string()
    .regex(durationPattern, "Must be a positive duration such as 30s, 5m, or 1h")
    .default(defaultStepTimeout)
    .describe("Maximum duration of the step"),
  inputs: expressionMapSchema.optional(),
  outputs: expressionMapSchema.optional(),
});

const stepSchema = z.discriminatedUnion("type", [scriptStepSchema]);

const inputBase = {
  description: z.string().optional().describe("Description of the input"),
  required: z
    .boolean()
    .default(false)
    .describe("Whether the input must be given. It cannot be combined with default"),
};

// z.number() accepts only finite numbers.
const inputSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("string"), ...inputBase, default: z.string().optional() }),
  z.strictObject({ type: z.literal("number"), ...inputBase, default: z.number().optional() }),
  z.strictObject({ type: z.literal("boolean"), ...inputBase, default: z.boolean().optional() }),
  z.strictObject({
    type: z.literal("choice"),
    ...inputBase,
    options: z.array(z.string().min(1)).min(1).describe("Values that the input accepts"),
    default: z.string().optional(),
  }),
]);

/** Schema for a workflow definition object, independent of its file format. */
export const definitionSchema = z.strictObject({
  version: z.literal(definitionVersion),
  inputs: z
    .record(identifierSchema, inputSchema)
    .optional()
    .describe("Values that the workflow receives when it starts"),
  start: stepIdSchema,
  steps: z.record(stepIdSchema, stepSchema),
});

/** A workflow definition that has passed {@link definitionSchema}. */
export type Definition = z.infer<typeof definitionSchema>;

/** Creates the JSON Schema of a workflow definition for editors and other tools. */
export const createDefinitionJsonSchema = () => {
  return z.toJSONSchema(definitionSchema, { io: "input" });
};
