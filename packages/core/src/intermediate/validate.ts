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

/** Reports the steps from which no path reaches the end, so that the workflow could never finish. */
const validateTermination = (intermediate: Intermediate): ValidationError[] => {
  const { steps } = intermediate;
  const reachable = reachableSteps(intermediate);
  const sources = new Map<string, string[]>();
  const finishing: string[] = [];
  for (const id of reachable) {
    const next = steps[id]?.next;
    if (next === undefined) {
      continue;
    }
    const targets = transitionTargets(next);
    for (const { step } of targets) {
      sources.set(step, [...(sources.get(step) ?? []), id]);
    }
    const ends =
      next.type === "end" ||
      (next.type === "branch" && next.branches.some(({ to }) => to.type === "end"));
    // An unknown step is reported on its own, so it does not count as a path that never ends.
    if (ends || targets.some(({ step }) => !Object.hasOwn(steps, step))) {
      finishing.push(id);
    }
  }

  const canFinish = new Set<string>();
  for (let id = finishing.pop(); id !== undefined; id = finishing.pop()) {
    if (!canFinish.has(id)) {
      canFinish.add(id);
      finishing.push(...(sources.get(id) ?? []));
    }
  }
  return reachable
    .filter((id) => !canFinish.has(id))
    .map((id) => ({
      message: `Step ${id} cannot reach end, so the workflow could never finish`,
      path: ["steps", id, "next"],
    }));
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
      }
    }
  }
  errors.push(...validateTermination(intermediate));

  // An unknown step ends the path, and is reported above.
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
 * Every step must be reachable from `start`, and must have a path to the end.
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
