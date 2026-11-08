import { z } from "zod";

import { identifierPattern } from "../identifier.js";
import { inputDeclarationSchema } from "./declarations.js";

/** Version of the intermediate representation format. */
export const intermediateVersion = 1;

const stepIdSchema = z.string().min(1);
// References read names by identifier, so names that are not identifiers could not be read.
const inputNameSchema = z.string().regex(identifierPattern, "Must be a valid name");
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
  inputs: expressionMapSchema,
  outputs: expressionMapSchema,
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
