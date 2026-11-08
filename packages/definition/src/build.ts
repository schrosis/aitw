import { intermediateVersion } from "@aitw/core";
import type { InputDeclaration, Intermediate, IntermediateStep } from "@aitw/core";

import type { Definition } from "./schema.js";

const durationUnits: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000 };

/** Converts a duration that passed the schema, such as `5m`, to milliseconds. */
const toMilliseconds = (duration: string): number => {
  const unit = durationUnits[duration.slice(-1)];
  if (unit === undefined) {
    throw new Error(`Unsupported duration: ${duration}`);
  }
  return Number(duration.slice(0, -1)) * unit;
};

/** Answers of the wait steps, keyed by step ID, as their methods describe them. */
export type WaitAnswers = Readonly<
  Record<string, Readonly<Record<string, InputDeclaration>> | undefined>
>;

const buildStep = (
  id: string,
  step: Definition["steps"][string],
  answers: WaitAnswers,
): IntermediateStep => {
  const common = {
    inputs: step.inputs ?? {},
    next:
      step.next === "end" ? { type: "end" as const } : { step: step.next, type: "step" as const },
    outputs: step.outputs ?? {},
  };
  if (step.type === "script") {
    return { ...common, run: step.run, timeoutMs: toMilliseconds(step.timeout), type: "script" };
  }
  const stepAnswers = answers[id];
  return {
    ...common,
    ...(stepAnswers === undefined ? {} : { answers: { ...stepAnswers } }),
    method: step.method,
    type: "wait",
    with: step.with ?? {},
  };
};

/**
 * Builds the intermediate representation of a definition that passed the schema.
 *
 * @param answers Answers of the wait steps, which come from their methods.
 */
export const buildIntermediate = (
  definition: Definition,
  answers: WaitAnswers = {},
): Intermediate => ({
  inputs: definition.inputs ?? {},
  start: definition.start,
  steps: Object.fromEntries(
    Object.entries(definition.steps).map(([id, step]) => [id, buildStep(id, step, answers)]),
  ),
  version: intermediateVersion,
});

const definitionFields: Record<string, string> = { timeoutMs: "timeout" };

/** Converts a path in the intermediate representation to the matching definition path. */
export const toDefinitionPath = (path: readonly (number | string)[]): (number | string)[] => {
  const [root, id, field, ...rest] = path;
  // Only step fields are renamed. Step IDs keep their names.
  if (root !== "steps" || typeof field !== "string") {
    return [...path];
  }
  // A transition is written as a single value in a definition.
  if (field === "next") {
    return [root, id ?? "", field];
  }
  // Answers come from with, in a form that only the method knows.
  if (field === "answers") {
    return [root, id ?? "", "with"];
  }
  return [root, id ?? "", definitionFields[field] ?? field, ...rest];
};
