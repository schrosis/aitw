import { validateExpressions } from "./expressions.js";
import { executionOrder } from "./order.js";
import { intermediateSchema } from "./schema.js";
import type { Intermediate } from "./schema.js";

/** A problem found in an intermediate representation. */
export interface ValidationError {
  /** Path of the invalid value in the intermediate representation. */
  path: (number | string)[];
  message: string;
}

/** Result of {@link validateIntermediate}. */
export type ValidationResult =
  | { ok: true; intermediate: Intermediate }
  | { ok: false; errors: ValidationError[] };

const validateTransitions = (intermediate: Intermediate): ValidationError[] => {
  const errors: ValidationError[] = [];
  const { start, steps } = intermediate;

  if (!Object.hasOwn(steps, start)) {
    errors.push({ message: `Unknown step: ${start}`, path: ["start"] });
  }

  const sources = new Map<string, string>();
  for (const [id, { next: transition }] of Object.entries(steps)) {
    if (transition.type !== "step") {
      continue;
    }
    const next = transition.step;
    const path = ["steps", id, "next", "step"];
    if (!Object.hasOwn(steps, next)) {
      errors.push({ message: `Unknown step: ${next}`, path });
    } else if (next === start) {
      errors.push({ message: `Cannot transition to the start step: ${next}`, path });
    } else if (sources.has(next)) {
      errors.push({
        message: `Step ${next} is already the next step of ${sources.get(next)}`,
        path,
      });
    } else {
      sources.set(next, id);
    }
  }

  // An unknown step or a cycle ends the path. Both are reported above.
  const reachable = new Set(executionOrder(intermediate));
  for (const id of Object.keys(steps)) {
    if (!reachable.has(id)) {
      errors.push({ message: "Step is not reachable from start", path: ["steps", id] });
    }
  }

  return errors;
};

/**
 * Validates the shape and transitions of an intermediate representation.
 *
 * The first version accepts only a single path from `start` to completion.
 */
export const validateIntermediate = (input: unknown): ValidationResult => {
  const result = intermediateSchema.safeParse(input);
  if (!result.success) {
    return {
      errors: result.error.issues.map(({ message, path }) => ({
        message,
        path: path.filter((segment) => typeof segment !== "symbol"),
      })),
      ok: false,
    };
  }

  const errors = [...validateTransitions(result.data), ...validateExpressions(result.data)];
  return errors.length > 0 ? { errors, ok: false } : { intermediate: result.data, ok: true };
};
