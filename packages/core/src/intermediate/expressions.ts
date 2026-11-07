import { parseTemplate } from "../expression/template.js";
import type { Intermediate, Transition } from "./schema.js";
import type { ValidationError } from "./validate.js";

/** Fields of the script result that `output` can read. */
const resultFields = new Set(["exitCode", "stdout", "stderr"]);

/** Returns the IDs of the steps on the path from `start`, in execution order. */
const executionOrder = ({ start, steps }: Intermediate): string[] => {
  const order: string[] = [];
  let current: string | null = start;
  while (current !== null && Object.hasOwn(steps, current) && !order.includes(current)) {
    order.push(current);
    const next: Transition | undefined = steps[current]?.next;
    current = next?.type === "step" ? next.step : null;
  }
  return order;
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

/**
 * Validates the `${{ }}` references of every step.
 *
 * - `input` can read the declared output of a step that runs before it
 * - `run` can read the declared input of its own step
 * - `output` can read `exitCode`, `stdout`, and `stderr` of the script result
 */
export const validateExpressions = (intermediate: Intermediate): ValidationError[] => {
  const order = executionOrder(intermediate);
  const errors: ValidationError[] = [];

  for (const [index, id] of order.entries()) {
    const step = intermediate.steps[id];
    if (step === undefined) {
      continue;
    }
    const earlier = new Set(order.slice(0, index));

    for (const [name, expression] of Object.entries(step.input)) {
      errors.push(
        ...checkExpression(
          expression,
          ["steps", id, "input", name],
          ([root, source, field, key, ...rest]) => {
            if (
              root !== "steps" ||
              field !== "output" ||
              source === undefined ||
              key === undefined ||
              rest.length > 0
            ) {
              return "Input can reference only steps.<id>.output.<name>";
            }
            if (!earlier.has(source)) {
              return `Step ${source} does not run before ${id}`;
            }
            if (!Object.hasOwn(intermediate.steps[source]?.output ?? {}, key)) {
              return `Step ${source} does not declare the output ${key}`;
            }
            return undefined;
          },
        ),
      );
    }

    errors.push(
      ...checkExpression(step.run, ["steps", id, "run"], ([root, name, ...rest]) => {
        if (root !== "input" || name === undefined) {
          return "Run can reference only input.<name>";
        }
        if (!Object.hasOwn(step.input, name)) {
          return `Step ${id} does not declare the input ${name}`;
        }
        return rest.length > 0 ? "Run cannot reference a field of an input value" : undefined;
      }),
    );

    for (const [name, expression] of Object.entries(step.output)) {
      errors.push(
        ...checkExpression(expression, ["steps", id, "output", name], ([root, field, ...rest]) =>
          root === "result" && field !== undefined && resultFields.has(field) && rest.length === 0
            ? undefined
            : "Output can reference only result.exitCode, result.stdout, or result.stderr",
        ),
      );
    }
  }

  return errors;
};
