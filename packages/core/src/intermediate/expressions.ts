import { parseTemplate } from "../expression/template.js";
import { executionOrder } from "./order.js";
import type { Intermediate } from "./schema.js";
import type { ValidationError } from "./validate.js";

/** Fields of the script result that `outputs` can read. */
const scriptResultFields: ReadonlySet<string> = new Set(["exitCode", "stdout", "stderr"]);

/** Returns every string in a JSON value with its path, such as the strings of `with`. */
const stringLeaves = (
  value: unknown,
  path: (number | string)[],
): { path: (number | string)[]; text: string }[] => {
  if (typeof value === "string") {
    return [{ path, text: value }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => stringLeaves(item, [...path, index]));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => stringLeaves(item, [...path, key]));
  }
  return [];
};

/**
 * Checks a field that may contain `${{ }}` references.
 *
 * @param check Returns a message when a reference is not allowed, or `undefined` when it is.
 */
const checkExpression = (
  text: string,
  path: (number | string)[],
  check: (reference: readonly string[]) => string | undefined,
): ValidationError[] => {
  const parsed = parseTemplate(text);
  if (!parsed.ok) {
    return [{ message: parsed.message, path }];
  }
  return parsed.template.flatMap((part) => {
    if (part.type === "text") {
      return [];
    }
    const message = check(part.path);
    return message === undefined ? [] : [{ message: `${message}: ${part.source}`, path }];
  });
};

/** What a field of a step can reference, in addition to earlier steps and the workflow input. */
interface Scope {
  /** Whether the field can read the declared input of its own step. */
  inputs: boolean;
  /**
   * Fields of the result that the field can read. `any` allows every field, for a wait method
   * whose result is known only when it runs.
   */
  result?: ReadonlySet<string> | "any";
}

const describeScope = ({ inputs, result }: Scope): string => {
  const references = [
    "steps.<id>.outputs.<name>",
    "workflow.inputs.<name>",
    ...(inputs ? ["inputs.<name>"] : []),
    ...(result === "any"
      ? ["result.<name>"]
      : [...(result ?? [])].map((field) => `result.${field}`)),
  ];
  return `${references.slice(0, -1).join(", ")}, or ${references.at(-1) ?? ""}`;
};

/**
 * Validates the `${{ }}` references of every step.
 *
 * The environment of the workflow can read only the declared input of the workflow.
 *
 * Every field of a step can read the declared output of a step that runs before it, and the declared
 * input of the workflow. In addition, `run`, the strings of `with`, and `outputs` can read the
 * declared inputs of their own step, and so can the environment of a script step. `outputs` can read the result: `exitCode`, `stdout`, and
 * `stderr` of a script, or the declared answers of a wait step.
 */
export const validateExpressions = (intermediate: Intermediate): ValidationError[] => {
  const order = executionOrder(intermediate);
  const errors: ValidationError[] = [];

  // The environment of the workflow is evaluated once when it starts, before any step runs.
  for (const [name, expression] of Object.entries(intermediate.env ?? {})) {
    errors.push(
      ...checkExpression(expression, ["env", name], ([root, first, second, ...rest]) => {
        if (root !== "workflow" || first !== "inputs" || second === undefined) {
          return "The environment of the workflow can reference only workflow.inputs.<name>";
        }
        if (!Object.hasOwn(intermediate.inputs, second)) {
          return `The workflow does not declare the input ${second}`;
        }
        return rest.length > 0 ? "Cannot reference a field of a workflow input value" : undefined;
      }),
    );
  }

  // Steps that run before the current step. It grows as the loop moves forward.
  const earlier = new Set<string>();
  for (const id of order) {
    const step = intermediate.steps[id];
    if (step === undefined) {
      continue;
    }

    const check =
      (scope: Scope) =>
      ([root, first, second, third, ...rest]: readonly string[]): string | undefined => {
        const unsupported = `Can reference only ${describeScope(scope)}`;
        if (root === "steps") {
          if (first === undefined || second !== "outputs" || third === undefined) {
            return unsupported;
          }
          if (!earlier.has(first)) {
            return `Step ${first} does not run before ${id}`;
          }
          if (!Object.hasOwn(intermediate.steps[first]?.outputs ?? {}, third)) {
            return `Step ${first} does not declare the output ${third}`;
          }
          return rest.length > 0 ? "Cannot reference a field of an output value" : undefined;
        }
        if (root === "workflow") {
          if (first !== "inputs" || second === undefined) {
            return unsupported;
          }
          if (!Object.hasOwn(intermediate.inputs, second)) {
            return `The workflow does not declare the input ${second}`;
          }
          return third === undefined
            ? undefined
            : "Cannot reference a field of a workflow input value";
        }
        if (root === "inputs" && scope.inputs && first !== undefined) {
          if (!Object.hasOwn(step.inputs, first)) {
            return `Step ${id} does not declare the input ${first}`;
          }
          return second === undefined ? undefined : "Cannot reference a field of an input value";
        }
        if (root === "result" && scope.result !== undefined && first !== undefined) {
          if (scope.result === "any") {
            return undefined;
          }
          if (step.type === "wait" && !scope.result.has(first)) {
            return `Step ${id} does not declare the answer ${first}`;
          }
          return scope.result.has(first) && second === undefined ? undefined : unsupported;
        }
        return unsupported;
      };

    for (const [name, expression] of Object.entries(step.inputs)) {
      errors.push(
        ...checkExpression(expression, ["steps", id, "inputs", name], check({ inputs: false })),
      );
    }
    if (step.type === "script") {
      errors.push(...checkExpression(step.run, ["steps", id, "run"], check({ inputs: true })));
      for (const [name, expression] of Object.entries(step.env ?? {})) {
        errors.push(
          ...checkExpression(expression, ["steps", id, "env", name], check({ inputs: true })),
        );
      }
    } else {
      for (const { path, text } of stringLeaves(step.with, ["steps", id, "with"])) {
        errors.push(...checkExpression(text, path, check({ inputs: true })));
      }
    }
    const result =
      step.type === "script"
        ? scriptResultFields
        : step.answers === undefined
          ? "any"
          : new Set(Object.keys(step.answers));
    for (const [name, expression] of Object.entries(step.outputs)) {
      errors.push(
        ...checkExpression(
          expression,
          ["steps", id, "outputs", name],
          check({ inputs: true, result }),
        ),
      );
    }
    earlier.add(id);
  }

  return errors;
};
