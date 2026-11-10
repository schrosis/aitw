import { validateExpressions } from "./expressions.js";
import { checkInputDeclarations } from "./declarations.js";
import { reachableSteps, transitionTargets } from "./order.js";
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

const prefixed = (prefix: (number | string)[], errors: ValidationError[]): ValidationError[] =>
  errors.map(({ message, path }) => ({ message, path: [...prefix, ...path] }));

/** Validates the parts of declarations that the schema cannot express. */
const validateDeclarations = ({ inputs, steps }: Intermediate): ValidationError[] => [
  ...prefixed(["inputs"], checkInputDeclarations(inputs)),
  ...Object.entries(steps).flatMap(([id, step]): ValidationError[] => {
    // Providers return a structured result as an object.
    if (step.type === "ai" && step.schema !== undefined && step.schema.type !== "object") {
      return [{ message: "The schema must have type: object", path: ["steps", id, "schema"] }];
    }
    if (step.type !== "wait" || step.answers === undefined) {
      return [];
    }
    const errors = prefixed(["steps", id, "answers"], checkInputDeclarations(step.answers));
    // Answers are built before the workflow runs, so expressions in them would never be
    // evaluated.
    for (const [name, declaration] of Object.entries(step.answers)) {
      const values = [
        declaration.default,
        ...(declaration.type === "choice" ? declaration.options : []),
      ];
      if (values.some((value) => typeof value === "string" && value.includes("${{"))) {
        errors.push({
          message: "Defaults and options of answers cannot contain expressions",
          path: ["steps", id, "answers", name],
        });
      }
    }
    return errors;
  }),
];

/** Checks that the branches of a step end with one fallback, and that the others have a condition. */
const validateBranches = (id: string, step: Intermediate["steps"][string]): ValidationError[] => {
  if (step.next.type !== "branch") {
    return [];
  }
  const { branches } = step.next;
  const path = (index: number): (number | string)[] => ["steps", id, "next", "branches", index];
  return branches.flatMap((branch, index): ValidationError[] => {
    const last = index === branches.length - 1;
    if (last && branch.if !== undefined) {
      return [
        {
          message:
            "The last branch must have no if, so that a branch is always taken. Use to: end to finish",
          path: [...path(index), "if"],
        },
      ];
    }
    if (!last && branch.if === undefined) {
      return [{ message: "Only the last branch can have no if", path: [...path(index), "to"] }];
    }
    return [];
  });
};

/** Reports transitions that go back to a step on their own path. Loops are not supported yet. */
const validateCycles = ({ start, steps }: Intermediate): ValidationError[] => {
  const errors: ValidationError[] = [];
  const finished = new Set<string>();
  const onPath = new Set<string>();
  const visit = (id: string): void => {
    const step = steps[id];
    if (step === undefined || !Object.hasOwn(steps, id) || finished.has(id)) {
      return;
    }
    onPath.add(id);
    for (const { path, step: target } of transitionTargets(step.next)) {
      if (onPath.has(target)) {
        // A transition to the start has its own message.
        if (target !== start) {
          errors.push({
            message: `Cannot transition back to step ${target}: loops are not supported yet`,
            path: ["steps", id, "next", ...path],
          });
        }
      } else {
        visit(target);
      }
    }
    onPath.delete(id);
    finished.add(id);
  };
  visit(start);
  return errors;
};

const validateTransitions = (intermediate: Intermediate): ValidationError[] => {
  const errors: ValidationError[] = [];
  const { start, steps } = intermediate;

  if (!Object.hasOwn(steps, start)) {
    errors.push({ message: `Unknown step: ${start}`, path: ["start"] });
  }

  for (const [id, step] of Object.entries(steps)) {
    errors.push(...validateBranches(id, step));
    for (const { path: targetPath, step: next } of transitionTargets(step.next)) {
      const path = ["steps", id, "next", ...targetPath];
      if (!Object.hasOwn(steps, next)) {
        errors.push({ message: `Unknown step: ${next}`, path });
      } else if (next === start) {
        errors.push({ message: `Cannot transition to the start step: ${next}`, path });
      }
    }
  }
  errors.push(...validateCycles(intermediate));

  // An unknown step or a cycle ends the path. Both are reported above.
  const reachable = new Set(reachableSteps(intermediate));
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
 * Every step must be reachable from `start`, and loops are not supported yet.
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

  const errors = [
    ...validateDeclarations(result.data),
    ...validateTransitions(result.data),
    ...validateExpressions(result.data),
  ];
  return errors.length > 0 ? { errors, ok: false } : { intermediate: result.data, ok: true };
};
