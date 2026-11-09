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

const transitionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("step"), step: stepIdSchema }),
  z.strictObject({ type: z.literal("end") }),
]);

const scriptStepSchema = z.strictObject({
  type: z.literal("script"),
  run: z.string().min(1),
  next: transitionSchema,
  timeoutMs: z.int().positive(),
  inputs: expressionMapSchema,
  outputs: expressionMapSchema,
  env: envSchema,
});

const waitStepSchema = z.strictObject({
  type: z.literal("wait"),
  method: z.string().min(1),
  next: transitionSchema,
  /** Options of the method as the definition writes them. Strings may contain expressions. */
  with: z.record(z.string(), z.json()),
  /**
   * Values that the step receives as answers, built from the method. A method that does not
   * receive answers has none, and its result is not checked before running.
   */
  answers: z.record(inputNameSchema, inputDeclarationSchema).optional(),
  inputs: expressionMapSchema,
  outputs: expressionMapSchema,
});

/** Schema of the intermediate representation that the engine executes. */
export const intermediateSchema = z.strictObject({
  version: z.literal(intermediateVersion),
  inputs: z.record(inputNameSchema, inputDeclarationSchema),
  /** Environment variables of every script step. Values can reference only `workflow.inputs`. */
  env: envSchema,
  /** Path of a dotenv file, relative to the project root, that script steps read. */
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
  steps: z.record(stepIdSchema, z.discriminatedUnion("type", [scriptStepSchema, waitStepSchema])),
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
