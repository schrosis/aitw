import { ExpressionError, tokenize } from "./lexer.js";
import type { Operator, Token } from "./lexer.js";

/** A condition of a transition, as a tree. */
export type Condition =
  | { type: "literal"; value: boolean | number | string | null }
  | { type: "reference"; path: string[] }
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
  let index = 0;

  const takeOperator = (...operators: readonly Operator[]): Operator | undefined => {
    const token = tokens[index];
    if (token?.kind === "operator" && operators.includes(token.value)) {
      index += 1;
      return token.value;
    }
    return undefined;
  };

  const parsePrimary = (): Condition => {
    if (takeOperator("(") !== undefined) {
      const inner = parseOr();
      if (takeOperator(")") === undefined) {
        throw new ExpressionError("Expected )");
      }
      return inner;
    }
    const token = tokens[index];
    if (token === undefined || token.kind === "operator") {
      throw new ExpressionError(
        token === undefined ? "Expected a value at the end" : `Unexpected ${token.value}`,
      );
    }
    index += 1;
    return token.kind === "literal"
      ? { type: "literal", value: token.value }
      : { path: token.path, type: "reference" };
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
  const rest = tokens[index];
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
 * It supports `==`, `!=`, `&&`, `||`, `!`, parentheses, references, and literals: strings in
 * single quotes, numbers, `true`, `false`, and `null`.
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

/** Returns the paths of the references of a condition. */
export const conditionReferences = (condition: Condition): string[][] => {
  switch (condition.type) {
    case "literal": {
      return [];
    }
    case "reference": {
      return [condition.path];
    }
    case "not": {
      return conditionReferences(condition.operand);
    }
    default: {
      return [...conditionReferences(condition.left), ...conditionReferences(condition.right)];
    }
  }
};

/** Reads a path of own data properties. A value that is not there is `null`. */
const readReference = (
  context: Readonly<Record<string, unknown>>,
  path: readonly string[],
): unknown => {
  let value: unknown = context;
  for (const segment of path) {
    const descriptor =
      typeof value === "object" && value !== null
        ? Object.getOwnPropertyDescriptor(value, segment)
        : undefined;
    if (descriptor === undefined || !("value" in descriptor)) {
      return null;
    }
    const next: unknown = descriptor.value;
    value = next;
  }
  return value ?? null;
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
    case "literal": {
      return condition.value;
    }
    case "reference": {
      return readReference(context, condition.path);
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
 * Values are compared without converting their types, and a reference to a value that is not
 * there, such as of a step that has not run, is `null`. `!`, `&&`, `||`, and the condition itself
 * need `true` or `false`.
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
