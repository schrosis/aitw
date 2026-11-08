import { parseTemplate } from "../expression/template.js";
import { executionOrder } from "./order.js";
import type { Intermediate } from "./schema.js";
import type { ValidationError } from "./validate.js";

/** Fields of the script result that `outputs` can read. */
const resultFields = new Set(["exitCode", "stdout", "stderr"]);

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
  /** Whether the field can read the script result. */
  result: boolean;
}

const describeScope = ({ inputs, result }: Scope): string => {
  const references = [
    "steps.<id>.outputs.<name>",
    "workflow.inputs.<name>",
    ...(inputs ? ["inputs.<name>"] : []),
    ...(result ? ["result.exitCode", "result.stdout", "result.stderr"] : []),
  ];
  return `${references.slice(0, -1).join(", ")}, or ${references.at(-1) ?? ""}`;
};

/**
 * Validates the `${{ }}` references of every step.
 *
 * Every field can read the declared output of a step that runs before it, and the declared
 * input of the workflow. In addition, `run` and `outputs` can read the declared inputs of their
 * own step, and `outputs` can read `exitCode`, `stdout`, and `stderr` of the script result.
 */
export const validateExpressions = (intermediate: Intermediate): ValidationError[] => {
  const order = executionOrder(intermediate);
  const errors: ValidationError[] = [];

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
        if (root === "result" && scope.result && first !== undefined) {
          return resultFields.has(first) && second === undefined ? undefined : unsupported;
        }
        return unsupported;
      };

    for (const [name, expression] of Object.entries(step.inputs)) {
      errors.push(
        ...checkExpression(
          expression,
          ["steps", id, "inputs", name],
          check({ inputs: false, result: false }),
        ),
      );
    }
    errors.push(
      ...checkExpression(step.run, ["steps", id, "run"], check({ inputs: true, result: false })),
    );
    for (const [name, expression] of Object.entries(step.outputs)) {
      errors.push(
        ...checkExpression(
          expression,
          ["steps", id, "outputs", name],
          check({ inputs: true, result: true }),
        ),
      );
    }
    earlier.add(id);
  }

  return errors;
};
