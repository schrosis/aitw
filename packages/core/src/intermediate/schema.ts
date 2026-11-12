import { z } from "zod";

import {
  checkDotenvPath,
  envNameMessage,
  envNamePattern,
  identifierPattern,
} from "../identifier.js";
import { inputDeclarationSchema } from "./declarations.js";

/** Version of the intermediate representation format. */
export const intermediateVersion = 1;

const stepIdSchema = z.string().min(1);
// References read names by identifier, so names that are not identifiers could not be read.
const inputNameSchema = z.string().regex(identifierPattern, "Must be a valid name");
const expressionMapSchema = z.record(z.string().min(1), z.string().min(1));

/**
 * Environment variables to set, keyed by name. Values may contain expressions.
 *
 * It is optional, so that the histories of runs from before it existed still replay.
 */
const envSchema = z.record(z.string().regex(envNamePattern, envNameMessage), z.string()).optional();

const directTransitionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("step"), step: stepIdSchema }),
  z.strictObject({ type: z.literal("end") }),
]);

const transitionSchema = z.discriminatedUnion("type", [
  ...directTransitionSchema.options,
  z.strictObject({
    type: z.literal("branch"),
    /** Evaluated in order. The first whose condition holds is taken, and the last has none. */
    branches: z
      .array(z.strictObject({ if: z.string().min(1).optional(), to: directTransitionSchema }))
      .min(1),
  }),
]);

/** Times that a step can run in a run. A step without it has no limit. */
const maxVisitsSchema = z.int().positive().optional();

/**
 * Whether the workflow goes on when the step fails, with `result.ok` set to `false`. A step
 * without it stops the workflow when it fails.
 */
const continueOnErrorSchema = z.boolean().optional();

const scriptStepSchema = z.strictObject({
  type: z.literal("script"),
  maxVisits: maxVisitsSchema,
  continueOnError: continueOnErrorSchema,
  run: z.string().min(1),
  next: transitionSchema,
  timeoutMs: z.int().positive(),
  inputs: expressionMapSchema,
  outputs: expressionMapSchema,
  env: envSchema,
});

const waitStepSchema = z.strictObject({
  type: z.literal("wait"),
  maxVisits: maxVisitsSchema,
  method: z.string().min(1),
  next: transitionSchema,
  /** Options of the method as the definition writes them. Strings may contain expressions. */
  with: z.record(z.string(), z.json()),
  /**
   * Values that the step receives as answers, built from the method. A method that does not
   * receive answers has none, and its result is not checked before running.
   */
  answers: z.record(inputNameSchema, inputDeclarationSchema).optional(),
  /**
   * `worker` when the Worker of the run answers the step with the method, which the method
   * declares. Without it, the process that follows the run answers.
   */
  respondIn: z.literal("worker").optional(),
  inputs: expressionMapSchema,
  outputs: expressionMapSchema,
});

const aiStepSchema = z.strictObject({
  type: z.literal("ai"),
  maxVisits: maxVisitsSchema,
  continueOnError: continueOnErrorSchema,
  /** Name of the provider that runs the step, such as `claude-code`. */
  provider: z.string().min(1),
  /** Model to use, passed to the provider as it is. The provider chooses one when it is omitted. */
  model: z.string().min(1).optional(),
  prompt: z.string().min(1),
  /** JSON Schema of the result. Without it, the result is text. */
  schema: z.record(z.string(), z.json()).optional(),
  /** Whether a step that runs again continues its previous session. */
  session: z.enum(["reuse", "new"]),
  /** Options of the provider as the definition writes them. Strings may contain expressions. */
  with: z.record(z.string(), z.json()),
  next: transitionSchema,
  timeoutMs: z.int().positive(),
  inputs: expressionMapSchema,
  outputs: expressionMapSchema,
  env: envSchema,
});

/** Schema of the intermediate representation that the engine executes. */
export const intermediateSchema = z.strictObject({
  version: z.literal(intermediateVersion),
  inputs: z.record(inputNameSchema, inputDeclarationSchema),
  /** Environment variables of every script and AI step. Values can reference only `workflow.inputs`. */
  env: envSchema,
  /** Path of a dotenv file, relative to the project root, that script and AI steps read. */
  dotenv: z
    .string()
    .min(1)
    .superRefine((path, context) => {
      const message = checkDotenvPath(path);
      if (message !== undefined) {
        context.addIssue({ code: "custom", message });
      }
    })
    .optional(),
  start: stepIdSchema,
  steps: z.record(
    stepIdSchema,
    z.discriminatedUnion("type", [scriptStepSchema, waitStepSchema, aiStepSchema]),
  ),
});

/** A workflow in the intermediate representation. */
export type Intermediate = z.infer<typeof intermediateSchema>;

/** Where a workflow goes after a step. */
export type Transition = z.infer<typeof transitionSchema>;

/** A step in the intermediate representation. */
export type IntermediateStep = Intermediate["steps"][string];

/** A script step in the intermediate representation. */
export type ScriptStep = Extract<IntermediateStep, { type: "script" }>;

/** A wait step in the intermediate representation. */
export type WaitStep = Extract<IntermediateStep, { type: "wait" }>;

/** An AI step in the intermediate representation. */
export type AiStep = Extract<IntermediateStep, { type: "ai" }>;
