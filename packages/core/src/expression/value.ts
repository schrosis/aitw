import { builtinHelpers } from "./helpers.js";
import type { Helper } from "./helpers.js";
import { ExpressionError } from "./lexer.js";
import type { Operator, Token } from "./lexer.js";

/** A value in a `${{ }}` expression. */
export type ValueExpression =
  | { type: "literal"; value: boolean | number | string | null }
  | { type: "reference"; path: string[] }
  | { type: "call"; name: string; arguments: ValueExpression[] };

type Call = Extract<ValueExpression, { type: "call" }>;

/** Reads the tokens of an expression from the start. */
export interface TokenReader {
  /** Returns the next token without reading it, or `undefined` at the end. */
  peek: () => Token | undefined;
  /** Reads the next token, or returns `undefined` at the end. */
  next: () => Token | undefined;
  /** Reads the next token if it is one of the operators, and returns it. */
  takeOperator: (...operators: readonly Operator[]) => Operator | undefined;
}

/** Returns a reader of tokens. */
export const createTokenReader = (tokens: readonly Token[]): TokenReader => {
  let index = 0;
  const peek = (): Token | undefined => tokens[index];
  const next = (): Token | undefined => {
    const token = tokens[index];
    if (token !== undefined) {
      index += 1;
    }
    return token;
  };
  const takeOperator = (...operators: readonly Operator[]): Operator | undefined => {
    const token = tokens[index];
    if (token?.kind === "operator" && operators.includes(token.value)) {
      index += 1;
      return token.value;
    }
    return undefined;
  };
  return { next, peek, takeOperator };
};

/** Reads the arguments of a call, after its name. */
const parseArguments = (reader: TokenReader): ValueExpression[] => {
  // The lexer reads a name as a function only when ( follows it.
  if (reader.takeOperator("(") === undefined) {
    throw new ExpressionError("Expected (");
  }
  if (reader.takeOperator(")") !== undefined) {
    return [];
  }
  const args = [parseValue(reader)];
  while (reader.takeOperator(",") !== undefined) {
    const token = reader.peek();
    if (token?.kind === "operator" && token.value === ")") {
      throw new ExpressionError("Expected a value after ,");
    }
    args.push(parseValue(reader));
  }
  if (reader.takeOperator(")") === undefined) {
    throw new ExpressionError("Expected )");
  }
  return args;
};

/**
 * Parses a literal, a reference, or a call.
 *
 * Whether a function exists and takes the number of the arguments is left to {@link checkCalls}.
 *
 * @throws ExpressionError when the tokens do not start with a value.
 */
export const parseValue = (reader: TokenReader): ValueExpression => {
  const token = reader.next();
  if (token === undefined) {
    throw new ExpressionError("Expected a value at the end");
  }
  switch (token.kind) {
    case "operator": {
      throw new ExpressionError(`Unexpected ${token.value}`);
    }
    case "literal": {
      return { type: "literal", value: token.value };
    }
    case "reference": {
      return { path: token.path, type: "reference" };
    }
    case "function": {
      return { arguments: parseArguments(reader), name: token.name, type: "call" };
    }
    default: {
      return token satisfies never;
    }
  }
};

/** Returns the paths of the references of an expression, including those in arguments, in order. */
export const expressionReferences = (expression: ValueExpression): string[][] => {
  switch (expression.type) {
    case "literal": {
      return [];
    }
    case "reference": {
      return [expression.path];
    }
    case "call": {
      return expression.arguments.flatMap(expressionReferences);
    }
    default: {
      return expression satisfies never;
    }
  }
};

const describeArity = ({ arity: { max, min } }: Helper): string => {
  if (min !== max) {
    return `${String(min)} to ${String(max)} arguments`;
  }
  return min === 1 ? "1 argument" : `${String(min)} arguments`;
};

/** Returns a message when a helper does not take the number of the arguments of a call. */
const checkArity = (helper: Helper, call: Call): string | undefined => {
  const count = call.arguments.length;
  return count < helper.arity.min || count > helper.arity.max
    ? `${call.name} takes ${describeArity(helper)} but got ${String(count)}`
    : undefined;
};

/**
 * Evaluates an expression.
 *
 * The arguments of a call are evaluated from left to right before the call.
 *
 * @param read Returns the value of a reference. It throws ExpressionError for a reference that
 *   cannot be read, which differs between templates and conditions.
 * @throws ExpressionError when a call fails.
 */
export const evaluateValue = (
  expression: ValueExpression,
  read: (path: readonly string[]) => unknown,
): unknown => {
  switch (expression.type) {
    case "literal": {
      return expression.value;
    }
    case "reference": {
      return read(expression.path);
    }
    case "call": {
      const args = expression.arguments.map((argument) => evaluateValue(argument, read));
      // Validation reports an unknown function and a wrong number of arguments. These guard the
      // callers that evaluate an expression without it.
      const helper = builtinHelpers.get(expression.name);
      if (helper === undefined) {
        throw new ExpressionError(`Unknown function: ${expression.name}`);
      }
      const arityMessage = checkArity(helper, expression);
      if (arityMessage !== undefined) {
        throw new ExpressionError(arityMessage);
      }
      const result = helper.call(args);
      if (!result.ok) {
        throw new ExpressionError(result.message);
      }
      return result.value;
    }
    default: {
      return expression satisfies never;
    }
  }
};

/** Returns every call in an expression, outer ones first. */
const callsOf = (expression: ValueExpression): Call[] =>
  expression.type === "call" ? [expression, ...expression.arguments.flatMap(callsOf)] : [];

const readNothing = (): never => {
  throw new Error("A call without references read a reference");
};

/** Evaluates the outermost calls that have no references, and returns the messages of failures. */
const evaluateConstantCalls = (expression: ValueExpression): string[] => {
  if (expression.type !== "call") {
    return [];
  }
  if (expressionReferences(expression).length > 0) {
    return expression.arguments.flatMap(evaluateConstantCalls);
  }
  try {
    evaluateValue(expression, readNothing);
    return [];
  } catch (error) {
    if (error instanceof ExpressionError) {
      return [error.message];
    }
    throw error;
  }
};

/**
 * Checks the calls of an expression: that each function exists and takes the number of its
 * arguments, and that a call without references returns a value.
 *
 * Calls are evaluated only when every name and number of arguments is right, so that one mistake
 * is reported once. A failure of a call without references is reported for the outermost one,
 * such as once for `trim(trim(1))`.
 *
 * @returns Messages of the problems, or an empty array.
 */
export const checkCalls = (expression: ValueExpression): string[] => {
  const available = [...builtinHelpers.keys()].join(", ");
  const problems = callsOf(expression).flatMap((call) => {
    const helper = builtinHelpers.get(call.name);
    if (helper === undefined) {
      return [`Unknown function: ${call.name}. Available functions: ${available}`];
    }
    const message = checkArity(helper, call);
    return message === undefined ? [] : [message];
  });
  return problems.length > 0 ? problems : evaluateConstantCalls(expression);
};
