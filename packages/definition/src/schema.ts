import {
  checkDotenvPath,
  envNameMessage,
  envNamePattern,
  identifierPattern,
  identifierSource,
  inputDeclarationDefinitionSchema,
} from "@aitw/core";
import { z } from "zod";

const stepIdPattern = new RegExp(`^(?!(?:end|start)$)${identifierSource}$`, "u");
const durationPattern = /^[1-9][0-9]*(?:s|m|h)$/u;

/** Definition format version supported by this package. */
export const definitionVersion = "v0.1";

/** Timeout applied to a script or AI step that does not specify one. */
export const defaultStepTimeout = "30m";

const identifierSchema = z
  .string()
  .regex(identifierPattern, "Must start with a letter and contain only letters, digits, or _");

const stepIdSchema = z
  .string()
  .regex(
    stepIdPattern,
    "Must start with a letter, contain only letters, digits, or _, and not be a reserved word: end or start",
  );

/** Where a step goes next: a step, or branches of which the first that holds is taken. */
const nextSchema = z.union(
  [
    identifierSchema,
    z
      .array(
        z.strictObject({
          if: z.string().min(1).optional().describe("Condition, such as ${{ outputs.ok == true }}"),
          to: identifierSchema.describe("Step to go to, or end"),
        }),
      )
      .min(1),
  ],
  { error: "Must be the name of a step, end, or a list of branches with if and to" },
);

const maxVisitsSchema = z
  .int()
  .positive()
  .optional()
  .describe("Times that the step can run in a run. It has no limit by default");

const expressionMapSchema = z.record(identifierSchema, z.string().min(1));

/**
 * Environment variables to set, keyed by name. Numbers and booleans are written as text, as
 * YAML reads `PORT: 3000` as a number.
 */
const envSchema = z
  .record(
    z.string().regex(envNamePattern, envNameMessage),
    z.union([z.string(), z.number(), z.boolean()]).transform(String),
  )
  .optional();

const scriptStepSchema = z.strictObject({
  type: z.literal("script"),
  run: z.string().min(1),
  next: nextSchema,
  maxVisits: maxVisitsSchema,
  timeout: z
    .string()
    .regex(durationPattern, "Must be a positive duration such as 30s, 5m, or 1h")
    .default(defaultStepTimeout)
    .describe("Maximum duration of the step"),
  inputs: expressionMapSchema.optional(),
  outputs: expressionMapSchema.optional(),
  env: envSchema.describe("Environment variables of the script. Values may contain expressions"),
});

const waitStepSchema = z.strictObject({
  type: z.literal("wait"),
  method: z.string().min(1).describe("How the step waits, such as terminal"),
  with: z
    .record(z.string(), z.json())
    .optional()
    .describe("Options of the method. Strings may contain expressions"),
  next: nextSchema,
  maxVisits: maxVisitsSchema,
  inputs: expressionMapSchema.optional(),
  outputs: expressionMapSchema.optional(),
});

const aiStepSchema = z.strictObject({
  type: z.literal("ai"),
  provider: z.string().min(1).describe("Provider that runs the step, such as claude-code"),
  model: z.string().min(1).optional().describe("Model to use. The provider chooses one by default"),
  prompt: z.string().min(1).describe("Instructions of the step. It may contain expressions"),
  schema: z
    .record(z.string(), z.json())
    .optional()
    .describe("JSON Schema of the result, which is text without it"),
  session: z
    .enum(["reuse", "new"])
    .default("reuse")
    .describe("Whether a step that runs again continues its previous session"),
  with: z
    .record(z.string(), z.json())
    .optional()
    .describe("Options of the provider. Strings may contain expressions"),
  next: nextSchema,
  maxVisits: maxVisitsSchema,
  timeout: z
    .string()
    .regex(durationPattern, "Must be a positive duration such as 30s, 5m, or 1h")
    .default(defaultStepTimeout)
    .describe("Maximum duration of the step"),
  inputs: expressionMapSchema.optional(),
  outputs: expressionMapSchema.optional(),
  env: envSchema.describe("Environment variables of the step. Values may contain expressions"),
});

const stepSchema = z.discriminatedUnion("type", [scriptStepSchema, waitStepSchema, aiStepSchema]);

/** Schema for a workflow definition object, independent of its file format. */
export const definitionSchema = z.strictObject({
  version: z.literal(definitionVersion),
  inputs: z
    .record(identifierSchema, inputDeclarationDefinitionSchema)
    .optional()
    .describe("Values that the workflow receives when it starts"),
  env: envSchema.describe(
    "Environment variables of every script and AI step. Values can reference workflow.inputs",
  ),
  dotenv: z
    .string()
    .min(1)
    .superRefine((path, context) => {
      const message = checkDotenvPath(path);
      if (message !== undefined) {
        context.addIssue({ code: "custom", message });
      }
    })
    .optional()
    .describe("Path of a dotenv file, relative to the project root, that script and AI steps read"),
  start: stepIdSchema,
  steps: z.record(stepIdSchema, stepSchema),
});

/** A workflow definition that has passed {@link definitionSchema}. */
export type Definition = z.infer<typeof definitionSchema>;

/** Creates the JSON Schema of a workflow definition for editors and other tools. */
export const createDefinitionJsonSchema = () => {
  return z.toJSONSchema(definitionSchema, { io: "input" });
};
