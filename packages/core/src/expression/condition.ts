import { readReference } from "./evaluate.js";
import { ExpressionError, tokenize } from "./lexer.js";
import type { Token } from "./lexer.js";
import {
  createTokenReader,
  evaluateValue,
  expressionReferences,
  formatReference,
  parseValue,
} from "./value.js";
import type { ValueExpression } from "./value.js";

/** A condition of a transition, as a tree. */
export type Condition =
  | ValueExpression
  | { type: "not"; operand: Condition }
  | { type: "and" | "or"; left: Condition; right: Condition }
  | { type: "equal" | "notEqual"; left: Condition; right: Condition };

/** Result of {@link parseCondition}. */
export type ParseConditionResult =
  | { ok: true; condition: Condition }
  | { ok: false; message: string };

/** Result of {@link evaluateCondition}. */
export type EvaluateConditionResult = { ok: true; value: boolean } | { ok: false; message: string };

/** Parses tokens, where `||` binds loosest, then `&&`, the comparisons, and `!`. */
const parseTokens = (tokens: readonly Token[]): Condition => {
  const reader = createTokenReader(tokens);
  const { takeOperator } = reader;

  const parsePrimary = (): Condition => {
    if (takeOperator("(") !== undefined) {
      const inner = parseOr();
      if (takeOperator(")") === undefined) {
        throw new ExpressionError("Expected )");
      }
      return inner;
    }
    return parseValue(reader);
  };

  const parseNot = (): Condition =>
    takeOperator("!") === undefined ? parsePrimary() : { operand: parseNot(), type: "not" };

  const parseEquality = (): Condition => {
    const left = parseNot();
    const operator = takeOperator("==", "!=");
    if (operator === undefined) {
      return left;
    }
    return { left, right: parseNot(), type: operator === "==" ? "equal" : "notEqual" };
  };

  const parseAnd = (): Condition => {
    let left = parseEquality();
    while (takeOperator("&&") !== undefined) {
      left = { left, right: parseEquality(), type: "and" };
    }
    return left;
  };

  const parseOr = (): Condition => {
    let left = parseAnd();
    while (takeOperator("||") !== undefined) {
      left = { left, right: parseAnd(), type: "or" };
    }
    return left;
  };

  const condition = parseOr();
  const rest = reader.peek();
  if (rest !== undefined) {
    throw new ExpressionError(
      rest.kind === "operator" ? `Unexpected ${rest.value}` : "Expected an operator",
    );
  }
  return condition;
};

const open = "${{";
const close = "}}";

/**
 * Parses a condition, which is one `${{ }}` expression such as `${{ outputs.verdict == 'ok' }}`.
 *
 * It supports `==`, `!=`, `&&`, `||`, `!`, parentheses, references, calls of helper functions
 * such as `trim(result.stdout)`, and literals: strings in single quotes, numbers, `true`,
 * `false`, and `null`.
 *
 * Whether a function exists and takes the number of the arguments is checked by validation.
 */
export const parseCondition = (text: string): ParseConditionResult => {
  const source = text.trim();
  if (!source.startsWith(open) || !source.endsWith(close)) {
    return { message: `A condition must be one \${{ }} expression: ${text}`, ok: false };
  }
  try {
    const tokens = tokenize(source.slice(open.length, -close.length), "condition");
    return { condition: parseTokens(tokens), ok: true };
  } catch (error) {
    if (error instanceof ExpressionError) {
      return { message: `Invalid condition: ${source}. ${error.message}`, ok: false };
    }
    throw error;
  }
};

/**
 * Returns the values of a condition, which its operators combine, from left to right.
 *
 * It is not public. Validation uses it to check the calls of a condition.
 */
export const conditionValues = (condition: Condition): ValueExpression[] => {
  switch (condition.type) {
    case "literal":
    case "reference":
    case "call": {
      return [condition];
    }
    case "not": {
      return conditionValues(condition.operand);
    }
    default: {
      return [...conditionValues(condition.left), ...conditionValues(condition.right)];
    }
  }
};

/** A value whose result must be `true` or `false`, returned by {@link booleanOperands}. */
export interface BooleanOperand {
  value: ValueExpression;
  /**
   * Whether the value is a reference that an earlier operand shows is not `null` when this one is
   * evaluated, such as the second `x` of `x != null && x` or of `x == null || x`.
   */
  checkedNotNull: boolean;
}

/** Returns a key of a reference, to compare it with others. */
const referenceKey = (path: readonly string[]): string => JSON.stringify(path);

/** Returns the reference that a comparison with `null` compares, such as `x` of `x == null`. */
const comparedWithNull = (left: Condition, right: Condition): string | undefined => {
  const isNull = (side: Condition): boolean => side.type === "literal" && side.value === null;
  if (left.type === "reference" && isNull(right)) {
    return referenceKey(left.path);
  }
  if (right.type === "reference" && isNull(left)) {
    return referenceKey(right.path);
  }
  return undefined;
};

/**
 * Returns the references that are not `null` when a condition has a result, such as `x` of
 * `x != null` when it is `true`.
 */
const notNullWhen = (condition: Condition, result: boolean): ReadonlySet<string> => {
  switch (condition.type) {
    case "equal":
    case "notEqual": {
      const key = comparedWithNull(condition.left, condition.right);
      // x == null is false, or x != null is true.
      return key !== undefined && (condition.type === "notEqual") === result
        ? new Set([key])
        : new Set();
    }
    case "not": {
      return notNullWhen(condition.operand, !result);
    }
    case "and":
    case "or": {
      // Both operands have the result when `&&` is true or `||` is false.
      return (condition.type === "and") === result
        ? new Set([...notNullWhen(condition.left, result), ...notNullWhen(condition.right, result)])
        : new Set();
    }
    default: {
      return new Set();
    }
  }
};

/**
 * Returns the values whose result must be `true` or `false`: the condition itself and the
 * operands of `!`, `&&`, and `||`, but not the operands of `==` and `!=`, from left to right.
 *
 * `&&` and `||` evaluate their right operand only when the left one is `true` and `false`, so a
 * comparison with `null` on the left, such as `x != null && x`, shows that a reference on the
 * right is not `null`.
 *
 * It is not public. Validation uses it to check the types of conditions.
 */
export const booleanOperands = (condition: Condition): BooleanOperand[] => {
  const collect = (current: Condition, notNull: ReadonlySet<string>): BooleanOperand[] => {
    switch (current.type) {
      case "literal":
      case "call": {
        return [{ checkedNotNull: false, value: current }];
      }
      case "reference": {
        return [{ checkedNotNull: notNull.has(referenceKey(current.path)), value: current }];
      }
      case "not": {
        return collect(current.operand, notNull);
      }
      case "and":
      case "or": {
        const leftResult = current.type === "and";
        return [
          ...collect(current.left, notNull),
          ...collect(
            current.right,
            new Set([...notNull, ...notNullWhen(current.left, leftResult)]),
          ),
        ];
      }
      case "equal":
      case "notEqual": {
        return [];
      }
      default: {
        return current satisfies never;
      }
    }
  };
  return collect(condition, new Set());
};

/** Returns the paths of the references of a condition, including those in arguments, in order. */
export const conditionReferences = (condition: Condition): string[][] =>
  conditionValues(condition).flatMap(expressionReferences);

/** Reads a reference as templates do, and names the path when it cannot be read. */
const read = (context: Readonly<Record<string, unknown>>, path: readonly string[]): unknown => {
  const result = readReference(context, path);
  if (!result.ok) {
    throw new ExpressionError(`Unknown reference: ${formatReference(path)}`);
  }
  return result.value;
};

const expectBoolean = (value: unknown): boolean => {
  if (typeof value !== "boolean") {
    throw new ExpressionError(
      `Expected true or false but found ${value === null ? "null" : typeof value}`,
    );
  }
  return value;
};

const evaluate = (condition: Condition, context: Readonly<Record<string, unknown>>): unknown => {
  switch (condition.type) {
    case "literal":
    case "reference":
    case "call": {
      return evaluateValue(condition, (path) => read(context, path));
    }
    case "not": {
      return !expectBoolean(evaluate(condition.operand, context));
    }
    case "and": {
      return (
        expectBoolean(evaluate(condition.left, context)) &&
        expectBoolean(evaluate(condition.right, context))
      );
    }
    case "or": {
      return (
        expectBoolean(evaluate(condition.left, context)) ||
        expectBoolean(evaluate(condition.right, context))
      );
    }
    case "equal": {
      return evaluate(condition.left, context) === evaluate(condition.right, context);
    }
    case "notEqual": {
      return evaluate(condition.left, context) !== evaluate(condition.right, context);
    }
    default: {
      return condition satisfies never;
    }
  }
};

/**
 * Evaluates a condition.
 *
 * Values are compared without converting their types. References are read as in templates, also
 * in the arguments of a call: a path that goes through `null`, a path under `steps` that cannot
 * be read, such as of a step that has not run, and `env.<name>` of a variable that is not set
 * are `null`. Any other reference that cannot be read, such as a misspelled field of
 * `result.data`, makes the result fail with `Unknown reference` and the path. `!`, `&&`, `||`,
 * and the condition itself need `true` or `false`. A call that fails, such as `trim(null)`,
 * makes the result fail with its message.
 */
export const evaluateCondition = (
  condition: Condition,
  context: Readonly<Record<string, unknown>>,
): EvaluateConditionResult => {
  try {
    return { ok: true, value: expectBoolean(evaluate(condition, context)) };
  } catch (error) {
    if (error instanceof ExpressionError) {
      return { message: error.message, ok: false };
    }
    throw error;
  }
};
