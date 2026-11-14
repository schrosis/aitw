import { describe, expect, it } from "vitest";

import { ExpressionError, expandIndexes, tokenize } from "./lexer.ts";
import type { ReferenceNames } from "./lexer.ts";

const names: readonly ReferenceNames[] = ["template", "condition"];

describe("expandIndexes", () => {
  it("splits the indexes off the segments", () => {
    expect(expandIndexes(["steps", "a", "visits[0]", "outputs"])).toEqual([
      "steps",
      "a",
      "visits",
      "0",
      "outputs",
    ]);
  });
});

describe("tokenize", () => {
  it.each(names)("reads operators with %s names", (kind) => {
    expect(tokenize("== != && || ! ( ) ,", kind)).toEqual(
      ["==", "!=", "&&", "||", "!", "(", ")", ","].map((value) => ({ kind: "operator", value })),
    );
  });

  it.each(names)("reads a name before ( as a function with %s names", (kind) => {
    expect(tokenize("trim(a, trimAll2())", kind)).toEqual([
      { kind: "function", name: "trim" },
      { kind: "operator", value: "(" },
      { kind: "reference", path: ["a"] },
      { kind: "operator", value: "," },
      { kind: "function", name: "trimAll2" },
      { kind: "operator", value: "(" },
      { kind: "operator", value: ")" },
      { kind: "operator", value: ")" },
    ]);
  });

  it.each(names)("reads other names before ( as references with %s names", (kind) => {
    const open = { kind: "operator", value: "(" };
    expect(tokenize("trim (a trim.x( Trim( a_b(", kind)).toEqual([
      { kind: "reference", path: ["trim"] },
      open,
      { kind: "reference", path: ["a"] },
      { kind: "reference", path: ["trim", "x"] },
      open,
      { kind: "reference", path: ["Trim"] },
      open,
      { kind: "reference", path: ["a_b"] },
      open,
    ]);
  });

  it.each(names)("reads a keyword before ( as a literal with %s names", (kind) => {
    expect(tokenize("true(", kind)).toEqual([
      { kind: "literal", value: true },
      { kind: "operator", value: "(" },
    ]);
  });

  it.each(names)("reads literals with %s names", (kind) => {
    expect(tokenize("'it''s' -1.5 true false null", kind)).toEqual([
      { kind: "literal", value: "it's" },
      { kind: "literal", value: -1.5 },
      { kind: "literal", value: true },
      { kind: "literal", value: false },
      { kind: "literal", value: null },
    ]);
  });

  it.each(names)("expands the indexes of a reference with %s names", (kind) => {
    expect(tokenize("steps.a.visits[0].outputs.b", kind)).toEqual([
      { kind: "reference", path: ["steps", "a", "visits", "0", "outputs", "b"] },
    ]);
  });

  it.each(names)("ignores spaces around tokens with %s names", (kind) => {
    expect(tokenize("  !a  ", kind)).toEqual([
      { kind: "operator", value: "!" },
      { kind: "reference", path: ["a"] },
    ]);
  });

  it("accepts names that start with _ in conditions", () => {
    expect(tokenize("env._TOKEN", "condition")).toEqual([
      { kind: "reference", path: ["env", "_TOKEN"] },
    ]);
  });

  it.each([["_env"], ["env._TOKEN"]])("rejects %s in templates", (expression) => {
    expect(() => tokenize(expression, "template")).toThrow(ExpressionError);
  });

  it.each(names)("rejects text that is not a token with %s names", (kind) => {
    expect(() => tokenize("a = b", kind)).toThrow(new ExpressionError("Unexpected text: = b"));
  });
});
