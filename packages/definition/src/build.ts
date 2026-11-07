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
  start: definition.start,
  steps: Object.fromEntries(
    Object.entries(definition.steps).map(([id, step]) => [
      id,
      {
        input: step.input ?? {},
        next: step.next === "end" ? null : step.next,
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
export const toDefinitionPath = (path: readonly (number | string)[]): (number | string)[] =>
  path.map((segment) =>
    typeof segment === "string" ? (definitionFields[segment] ?? segment) : segment,
  );
