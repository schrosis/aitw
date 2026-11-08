import { intermediateVersion } from "@aitw/core";
import type { Intermediate } from "@aitw/core";

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

/** Builds the intermediate representation of a definition that passed the schema. */
export const buildIntermediate = (definition: Definition): Intermediate => ({
  input: definition.input ?? {},
  start: definition.start,
  steps: Object.fromEntries(
    Object.entries(definition.steps).map(([id, step]) => [
      id,
      {
        input: step.input ?? {},
        next: step.next === "end" ? { type: "end" } : { step: step.next, type: "step" },
        output: step.output ?? {},
        run: step.run,
        timeoutMs: toMilliseconds(step.timeout),
        type: step.type,
      },
    ]),
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
  return [root, id ?? "", definitionFields[field] ?? field, ...rest];
};
