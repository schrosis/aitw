import { z } from "zod";

const identifierSource = "[A-Za-z][A-Za-z0-9_]*";
const identifierPattern = new RegExp(`^${identifierSource}$`, "u");
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
  input: expressionMapSchema.optional(),
  output: expressionMapSchema.optional(),
});

const stepSchema = z.discriminatedUnion("type", [scriptStepSchema]);

/** Schema for a workflow definition object, independent of its file format. */
export const definitionSchema = z.strictObject({
  version: z.literal(definitionVersion),
  start: stepIdSchema,
  steps: z.record(stepIdSchema, stepSchema),
});

/** A workflow definition that has passed {@link definitionSchema}. */
export type Definition = z.infer<typeof definitionSchema>;

/** Creates the JSON Schema of a workflow definition for editors and other tools. */
export const createDefinitionJsonSchema = () => {
  return z.toJSONSchema(definitionSchema, { io: "input" });
};
