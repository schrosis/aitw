import { booleanOperands, parseCondition } from "../expression/condition.js";
import { formatReference } from "../expression/value.js";
import type { ValueExpression } from "../expression/value.js";
import type { InputDeclaration } from "./declarations.js";
import { alwaysEarlierSteps, reachableSteps } from "./order.js";
import type { Intermediate } from "./schema.js";
import type { ValidationError } from "./validate.js";

const needsBoolean = "a condition needs true or false";

/** Writes a literal as in a condition, such as `'it''s'`. */
const formatLiteral = (value: boolean | number | string | null): string =>
  typeof value === "string" ? `'${value.replaceAll("'", "''")}'` : String(value);

/** Asks to compare a value that can be `null`, so that a missing value reads as false. */
const compareIt = (reference: string): string => `Compare it, such as ${reference} == true`;

/** Returns a message when a literal is not `true` or `false`. */
const checkLiteral = (value: boolean | number | string | null): string | undefined => {
  if (typeof value === "boolean") {
    return undefined;
  }
  if (value === null) {
    return "null is not true or false. A condition needs true or false";
  }
  return `${formatLiteral(value)} is a ${typeof value}, but ${needsBoolean}`;
};

/** Returns a message when a workflow input is not a boolean, or can be absent. */
const checkWorkflowInput = (
  reference: string,
  declaration: InputDeclaration | undefined,
): string | undefined => {
  if (declaration === undefined) {
    return undefined;
  }
  if (declaration.type !== "boolean") {
    // A choice is one of its options, which are strings.
    const type = declaration.type === "number" ? "a number" : "a string";
    return `${reference} is ${type}, but ${needsBoolean}`;
  }
  if (!declaration.required && declaration.default === undefined) {
    return `${reference} is null when it is not given. ${compareIt(reference)}, or give it a default`;
  }
  return undefined;
};

/**
 * Returns a message when the output of a step can be `null` because the step may not have run, or
 * may not have run the times of a visit.
 *
 * @param path The reference after `steps`, such as `["review", "outputs", "approved"]`.
 */
const checkStepOutput = (
  reference: string,
  id: string,
  [source, section, index]: readonly string[],
  alwaysEarlier: ReadonlySet<string>,
): string | undefined => {
  if (source === undefined) {
    return undefined;
  }
  // The latest output and the first visit have a value once the step has run.
  const visit = section === "visits" ? Number(index) : 0;
  if (visit === 0) {
    return alwaysEarlier.has(source)
      ? undefined
      : `${reference} is null when ${source} has not run before ${id}. ${compareIt(reference)}`;
  }
  return `${reference} is null when ${source} has not run ${String(visit + 1)} times before ${id}. ${compareIt(reference)}`;
};

/**
 * Returns a message when a value in a true-or-false position of a condition of a step is not
 * `true` or `false`, or can be `null`, as the definition shows.
 *
 * Calls and references to `outputs`, `result`, and `env` are left to the run.
 */
const checkOperand = (
  intermediate: Intermediate,
  id: string,
  operand: ValueExpression,
  alwaysEarlier: ReadonlySet<string>,
): string | undefined => {
  if (operand.type === "literal") {
    return checkLiteral(operand.value);
  }
  if (operand.type !== "reference") {
    return undefined;
  }
  const [root, first, second, ...rest] = operand.path;
  const reference = formatReference(operand.path);
  if (root === "workflow" && first === "inputs" && second !== undefined && rest.length === 0) {
    return checkWorkflowInput(
      reference,
      Object.hasOwn(intermediate.inputs, second) ? intermediate.inputs[second] : undefined,
    );
  }
  if (root === "steps") {
    return checkStepOutput(reference, id, operand.path.slice(1), alwaysEarlier);
  }
  return undefined;
};

/**
 * Reports the values in the true-or-false positions of conditions that the definition shows can
 * never be `true` or `false`, or can be `null`: outputs of a step that does not always run
 * before, visits other than the first of such a step, workflow inputs that are not booleans or can
 * be absent, and literals other than `true` and `false`.
 *
 * It expects an intermediate representation that passed `validateIntermediate`. It is not part of
 * `validateIntermediate`, because the workflow code runs that again for runs that already
 * started, which must not fail on replay.
 */
export const checkConditionTypes = (intermediate: Intermediate): ValidationError[] => {
  const alwaysEarlierOf = alwaysEarlierSteps(intermediate);
  return reachableSteps(intermediate).flatMap((id): ValidationError[] => {
    const next = intermediate.steps[id]?.next;
    if (next?.type !== "branch") {
      return [];
    }
    const alwaysEarlier = alwaysEarlierOf.get(id) ?? new Set<string>();
    return next.branches.flatMap((branch, index): ValidationError[] => {
      if (branch.if === undefined) {
        return [];
      }
      // validateIntermediate reports a condition that cannot be parsed.
      const parsed = parseCondition(branch.if);
      if (!parsed.ok) {
        return [];
      }
      const path = ["steps", id, "next", "branches", index, "if"];
      return booleanOperands(parsed.condition).flatMap((operand) => {
        const message = checkOperand(intermediate, id, operand, alwaysEarlier);
        return message === undefined ? [] : [{ message, path }];
      });
    });
  });
};
