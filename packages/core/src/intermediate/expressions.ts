import { conditionReferences, parseCondition } from "../expression/condition.js";
import { parseTemplate } from "../expression/template.js";
import { earlierSteps, reachableSteps } from "./order.js";
import type { Intermediate } from "./schema.js";
import type { ValidationError } from "./validate.js";

/** Fields of the script result that `outputs` can read. */
const scriptResultFields: ReadonlySet<string> = new Set(["exitCode", "stdout", "stderr"]);

/** Fields of the result of an AI step that `outputs` can read. */
const aiResultFields: ReadonlySet<string> = new Set(["data"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON Schema keywords that can declare properties outside of `properties`. */
const propertyKeywords = [
  "$ref",
  "allOf",
  "anyOf",
  "dependentSchemas",
  "if",
  "oneOf",
  "patternProperties",
  "unevaluatedProperties",
];

/** Returns whether a JSON Schema object can have properties that `properties` does not list. */
const allowsOtherProperties = (schema: Readonly<Record<string, unknown>>): boolean =>
  (schema.additionalProperties !== undefined && schema.additionalProperties !== false) ||
  propertyKeywords.some((keyword) => Object.hasOwn(schema, keyword));

/**
 * Checks a reference to the result of an AI step against its JSON Schema.
 *
 * Only `properties` are followed. What other keywords describe, such as `$ref` or `oneOf`, is
 * known only when the step runs, so references into them are allowed.
 *
 * An object without `additionalProperties` is treated as closed, which is stricter than JSON
 * Schema, so that a misspelled name is reported before the step runs. Set it to allow others.
 *
 * @param path The reference after `result`, such as `["data", "verdict"]`.
 */
const checkAiResult = (
  id: string,
  schema: Readonly<Record<string, unknown>> | undefined,
  [field, ...path]: readonly string[],
  unsupported: string,
): string | undefined => {
  if (field !== "data") {
    return unsupported;
  }
  if (schema === undefined) {
    return path.length === 0 ? undefined : `Step ${id} has no schema, so result.data is text`;
  }
  let current: unknown = schema;
  for (const segment of path) {
    if (!isRecord(current) || !isRecord(current.properties)) {
      return undefined;
    }
    if (!Object.hasOwn(current.properties, segment)) {
      return allowsOtherProperties(current)
        ? undefined
        : `The schema of step ${id} does not declare the property ${segment}`;
    }
    current = current.properties[segment];
  }
  return undefined;
};

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

/** Checks the references of a condition, such as of a branch. */
const checkCondition = (
  text: string,
  path: (number | string)[],
  check: (reference: readonly string[]) => string | undefined,
): ValidationError[] => {
  const parsed = parseCondition(text);
  if (!parsed.ok) {
    return [{ message: parsed.message, path }];
  }
  return conditionReferences(parsed.condition).flatMap((reference) => {
    const message = check(reference);
    return message === undefined ? [] : [{ message: `${message}: ${reference.join(".")}`, path }];
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
  /** Whether the field can read the declared outputs of its own step. */
  outputs?: boolean;
  /** Whether the field can read environment variables. */
  env?: boolean;
}

const describeScope = ({ env, inputs, outputs, result }: Scope): string => {
  const references = [
    "steps.<id>.outputs.<name>",
    "workflow.inputs.<name>",
    ...(inputs ? ["inputs.<name>"] : []),
    ...(outputs === true ? ["outputs.<name>"] : []),
    ...(env === true ? ["env.<name>"] : []),
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
 * input of the workflow. In addition, `run`, `prompt`, the strings of `with`, the environment of a
 * step, and `outputs` can read the declared inputs of their own step. `outputs` can read the
 * result: `exitCode`, `stdout`, and `stderr` of a script, the declared answers of a wait step, or
 * `data` of an AI step.
 *
 * A step can reference any step that can run before it. One on another branch reads as `null`
 * when it did not run. A condition of a branch can read `outputs`, `result`, the steps before it,
 * the input of the workflow, and `env`, whose names are not checked.
 */
export const validateExpressions = (intermediate: Intermediate): ValidationError[] => {
  const order = reachableSteps(intermediate);
  const earlierOf = earlierSteps(intermediate);
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

  for (const id of order) {
    // A step that can run before this one. It may be on another branch, and then it reads as null.
    const earlier = earlierOf.get(id) ?? new Set<string>();
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
        if (root === "outputs" && scope.outputs === true && first !== undefined) {
          if (!Object.hasOwn(step.outputs, first)) {
            return `Step ${id} does not declare the output ${first}`;
          }
          return second === undefined ? undefined : "Cannot reference a field of an output value";
        }
        if (root === "env" && scope.env === true && first !== undefined) {
          // Variables can come from outside of the definition, so that names cannot be checked.
          return second === undefined
            ? undefined
            : "Cannot reference a field of an environment variable";
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
          if (step.type === "ai") {
            const path = [first, second, third, ...rest].filter((part) => part !== undefined);
            return checkAiResult(id, step.schema, path, unsupported);
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
    }
    if (step.type === "ai") {
      errors.push(
        ...checkExpression(step.prompt, ["steps", id, "prompt"], check({ inputs: true })),
      );
    }
    if (step.type !== "wait") {
      for (const [name, expression] of Object.entries(step.env ?? {})) {
        errors.push(
          ...checkExpression(expression, ["steps", id, "env", name], check({ inputs: true })),
        );
      }
    }
    if (step.type !== "script") {
      for (const { path, text } of stringLeaves(step.with, ["steps", id, "with"])) {
        errors.push(...checkExpression(text, path, check({ inputs: true })));
      }
    }
    const resultOf = (): NonNullable<Scope["result"]> => {
      if (step.type === "script") {
        return scriptResultFields;
      }
      if (step.type === "ai") {
        return aiResultFields;
      }
      return step.answers === undefined ? "any" : new Set(Object.keys(step.answers));
    };
    const result = resultOf();
    for (const [name, expression] of Object.entries(step.outputs)) {
      errors.push(
        ...checkExpression(
          expression,
          ["steps", id, "outputs", name],
          check({ inputs: true, result }),
        ),
      );
    }
    if (step.next.type === "branch") {
      for (const [index, branch] of step.next.branches.entries()) {
        if (branch.if !== undefined) {
          errors.push(
            ...checkCondition(
              branch.if,
              ["steps", id, "next", "branches", index, "if"],
              check({ env: true, inputs: false, outputs: true, result }),
            ),
          );
        }
      }
    }
  }

  return errors;
};
