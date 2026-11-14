import { describe, expect, it, vi } from "vitest";

import type { Helper } from "./helpers.ts";
import { ExpressionError, tokenize } from "./lexer.ts";
import {
  checkCalls,
  createTokenReader,
  evaluateValue,
  expressionReferences,
  parseValue,
} from "./value.ts";
import type { ValueExpression } from "./value.ts";

// Helpers that take other numbers of arguments than trim, to check how they are described.
vi.mock(import("./helpers.ts"), async (importOriginal) => {
  const original = await importOriginal();
  const list: Helper = { arity: { max: 2, min: 2 }, call: (args) => ({ ok: true, value: args }) };
  const pad: Helper = { arity: { max: 2, min: 1 }, call: (args) => ({ ok: true, value: args }) };
  return {
    ...original,
    builtinHelpers: new Map([...original.builtinHelpers, ["list", list], ["pad", pad]]),
  };
});

const parse = (expression: string): ValueExpression => {
  const reader = createTokenReader(tokenize(expression, "template"));
  const value = parseValue(reader);
  expect(reader.peek()).toBeUndefined();
  return value;
};

const call = (name: string, ...args: ValueExpression[]): ValueExpression => ({
  arguments: args,
  name,
  type: "call",
});
const reference = (...path: string[]): ValueExpression => ({ path, type: "reference" });
const literal = (value: boolean | number | string | null): ValueExpression => ({
  type: "literal",
  value,
});

const unreadable = (): never => {
  throw new Error("Read a reference");
};

const readUnknown = (path: readonly string[]): never => {
  throw new ExpressionError(`Unknown reference: ${path.join(".")}`);
};

describe("parseValue", () => {
  it.each<[string, ValueExpression]>([
    ["trim()", call("trim")],
    ["trim(result.stdout)", call("trim", reference("result", "stdout"))],
    ["list(a, b.c)", call("list", reference("a"), reference("b", "c"))],
    ["trim(trim(a))", call("trim", call("trim", reference("a")))],
    ["list('it''s', -1.5)", call("list", literal("it's"), literal(-1.5))],
    ["list(true, null)", call("list", literal(true), literal(null))],
    ["  list(  a  ,b  )  ", call("list", reference("a"), reference("b"))],
    ["trim( )", call("trim")],
  ])("parses %s", (expression, value) => {
    expect(parse(expression)).toEqual(value);
  });

  it("parses a literal and a reference", () => {
    expect(parse("'a'")).toEqual(literal("a"));
    expect(parse("steps.a.visits[0].outputs.b")).toEqual(
      reference("steps", "a", "visits", "0", "outputs", "b"),
    );
  });

  it("reads a name and a following ( as a reference and an operator when spaces are between", () => {
    const reader = createTokenReader(tokenize("trim (a)", "template"));

    expect(parseValue(reader)).toEqual(reference("trim"));
    expect(reader.peek()).toEqual({ kind: "operator", value: "(" });
  });

  it("leaves the tokens after the value", () => {
    const reader = createTokenReader(tokenize("trim(a) == b", "condition"));

    expect(parseValue(reader)).toEqual(call("trim", reference("a")));
    expect(reader.takeOperator("==")).toBe("==");
  });

  it.each([
    ["trim(a", "Expected )"],
    ["trim(a b)", "Expected )"],
    ["trim(a == b)", "Expected )"],
    ["trim(a,)", "Expected a value after ,"],
    ["trim(a,", "Expected a value at the end"],
    ["trim(,a)", "Unexpected ,"],
    ["", "Expected a value at the end"],
    [")", "Unexpected )"],
  ])("rejects %j", (expression, message) => {
    const reader = createTokenReader(tokenize(expression, "condition"));

    expect(() => parseValue(reader)).toThrow(new ExpressionError(message));
  });
});

describe("expressionReferences", () => {
  it("lists the references in arguments in order", () => {
    expect(expressionReferences(parse("list(a, pad(b.c, 'x'))"))).toEqual([["a"], ["b", "c"]]);
  });

  it("lists nothing for a literal", () => {
    expect(expressionReferences(literal(1))).toEqual([]);
  });
});

describe("evaluateValue", () => {
  it("evaluates a call with the values of its arguments", () => {
    expect(evaluateValue(parse("trim(a)"), () => "  x\n")).toBe("x");
  });

  it("evaluates the arguments from left to right", () => {
    const read = vi.fn((path: readonly string[]) => path.join("."));

    expect(evaluateValue(parse("list(a, pad(b))"), read)).toEqual(["a", ["b"]]);
    expect(read.mock.calls).toEqual([[["a"]], [["b"]]]);
  });

  it("fails with the message of a helper", () => {
    expect(() => evaluateValue(parse("trim(a)"), () => null)).toThrow(
      new ExpressionError("trim expects a string but got null"),
    );
  });

  it("lets an error of reading pass", () => {
    expect(() => evaluateValue(parse("trim(a)"), readUnknown)).toThrow(
      new ExpressionError("Unknown reference: a"),
    );
  });

  it("fails on an unknown function", () => {
    expect(() => evaluateValue(call("nope", literal("a")), unreadable)).toThrow(
      new ExpressionError("Unknown function: nope"),
    );
  });

  it("fails on a wrong number of arguments", () => {
    expect(() => evaluateValue(call("trim", literal("a"), literal("b")), unreadable)).toThrow(
      new ExpressionError("trim takes 1 argument but got 2"),
    );
  });
});

describe("checkCalls", () => {
  it.each([["trim(a)"], ["trim('  a ')"], ["list(a, 1)"], ["pad(1)"], ["a"], ["'a'"]])(
    "accepts %s",
    (expression) => {
      expect(checkCalls(parse(expression))).toEqual([]);
    },
  );

  it("reports an unknown function with the available ones", () => {
    expect(checkCalls(parse("trimm(a)"))).toEqual([
      "Unknown function: trimm. Available functions: trim, list, pad",
    ]);
  });

  it.each([
    ["trim()", "trim takes 1 argument but got 0"],
    ["trim(a, b)", "trim takes 1 argument but got 2"],
    ["list(a)", "list takes 2 arguments but got 1"],
    ["pad()", "pad takes 1 to 2 arguments but got 0"],
    ["pad(a, b, c)", "pad takes 1 to 2 arguments but got 3"],
  ])("reports the number of the arguments of %s", (expression, message) => {
    expect(checkCalls(parse(expression))).toEqual([message]);
  });

  it.each([
    ["trim(3)", "trim expects a string but got number"],
    ["trim(null)", "trim expects a string but got null"],
    ["trim(trim(1))", "trim expects a string but got number"],
    ["list(a, trim(true))", "trim expects a string but got boolean"],
  ])("evaluates a call without references in %s", (expression, message) => {
    expect(checkCalls(parse(expression))).toEqual([message]);
  });

  it("does not evaluate a call with references", () => {
    expect(checkCalls(parse("trim(list(a, 1))"))).toEqual([]);
  });

  it("does not evaluate calls when a name or a number of arguments is wrong", () => {
    expect(checkCalls(parse("list(trimm(a), trim(1))"))).toEqual([
      "Unknown function: trimm. Available functions: trim, list, pad",
    ]);
    expect(checkCalls(parse("list(trim(1), trim(a, b))"))).toEqual([
      "trim takes 1 argument but got 2",
    ]);
  });

  it("reports every wrong name and number of arguments", () => {
    expect(checkCalls(parse("list(nope(a), trim())"))).toEqual([
      "Unknown function: nope. Available functions: trim, list, pad",
      "trim takes 1 argument but got 0",
    ]);
  });
});
