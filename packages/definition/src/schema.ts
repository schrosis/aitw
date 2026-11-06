import { z } from "zod";

const identifierPattern = /^[A-Za-z][A-Za-z0-9_]*$/u;
const stepIdPattern = /^(?!end$)[A-Za-z][A-Za-z0-9_]*$/u;
const durationPattern = /^[1-9][0-9]*(?:s|m|h)$/u;

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
    .optional(),
  input: expressionMapSchema.optional(),
  output: expressionMapSchema.optional(),
});

const stepSchema = z.discriminatedUnion("type", [scriptStepSchema]);

/** Schema for a workflow definition object, independent of its file format. */
export const definitionSchema = z.strictObject({
  version: z.literal(1),
  start: stepIdSchema,
  steps: z.record(stepIdSchema, stepSchema),
});

/** A workflow definition that has passed {@link definitionSchema}. */
export type Definition = z.infer<typeof definitionSchema>;

/** Creates the JSON Schema of a workflow definition for editors and other tools. */
export function createDefinitionJsonSchema() {
  return z.toJSONSchema(definitionSchema);
}
