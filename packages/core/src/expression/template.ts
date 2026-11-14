import { ExpressionError, tokenize } from "./lexer.js";
import type { Operator, Token } from "./lexer.js";
import { createTokenReader, parseValue } from "./value.js";
import type { ValueExpression } from "./value.js";

/** What the top level of a template expression can be. */
export type ReferenceOrCall = Extract<ValueExpression, { type: "call" | "reference" }>;

/** A part of a template: literal text, or a `${{ }}` expression. */
export type TemplatePart =
  | { type: "text"; value: string }
  | { type: "expression"; expression: ReferenceOrCall; source: string };

/** A string that may contain `${{ }}` expressions. */
export type Template = TemplatePart[];

/** Result of {@link parseTemplate}. */
export type ParseTemplateResult = { ok: true; template: Template } | { ok: false; message: string };

const open = "${{";
const close = "}}";

/** Operators that only conditions can use. Templates use only ( ) and , of calls. */
const conditionOperators: ReadonlySet<Operator> = new Set(["==", "!=", "&&", "||", "!"]);

const isConditionOperator = (token: Token): boolean =>
  token.kind === "operator" && conditionOperators.has(token.value);

/**
 * Returns the position of the `}}` that closes an expression, or -1 when there is none.
 *
 * A `}}` in a quoted string does not close it. A quote in a string is written as `''`, which
 * leaves and enters the string again.
 */
const findClose = (text: string, from: number): number => {
  let quoted = false;
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === "'") {
      quoted = !quoted;
    } else if (!quoted && text.startsWith(close, index)) {
      return index;
    }
  }
  return -1;
};

/**
 * Parses the inside of `${{ }}`.
 *
 * @throws ExpressionError when it is not a reference or a call.
 */
const parseInner = (inner: string): ReferenceOrCall => {
  const tokens = tokenize(inner, "template");
  if (tokens.some(isConditionOperator)) {
    throw new ExpressionError("Operators can be used only in the if of next");
  }
  const reader = createTokenReader(tokens);
  const expression = parseValue(reader);
  if (reader.peek() !== undefined) {
    throw new ExpressionError("Expected the end");
  }
  if (expression.type === "literal") {
    throw new ExpressionError("Use a reference or a function call");
  }
  return expression;
};

/**
 * Parses the `${{ }}` expressions in a string.
 *
 * An expression is a reference or a call of a helper function. A reference is a dot-separated
 * path of names, each of which can have an index such as `visits[0]`. The arguments of a call
 * can be references, calls, and literals. Operators can be used only in conditions.
 */
export const parseTemplate = (text: string): ParseTemplateResult => {
  const template: Template = [];
  let position = 0;

  while (position < text.length) {
    const start = text.indexOf(open, position);
    if (start === -1) {
      template.push({ type: "text", value: text.slice(position) });
      break;
    }
    if (start > position) {
      template.push({ type: "text", value: text.slice(position, start) });
    }

    const end = findClose(text, start + open.length);
    if (end === -1) {
      return { message: `Unterminated expression: ${text.slice(start)}`, ok: false };
    }

    const source = text.slice(start, end + close.length);
    try {
      const expression = parseInner(text.slice(start + open.length, end));
      template.push({ expression, source, type: "expression" });
    } catch (error) {
      if (error instanceof ExpressionError) {
        return { message: `Invalid expression: ${source}. ${error.message}`, ok: false };
      }
      throw error;
    }
    position = end + close.length;
  }

  return { ok: true, template };
};
