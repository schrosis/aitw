import { describe, expect, it } from "vitest";

import { conditionReferences, evaluateCondition, parseCondition } from "./condition.ts";

const context = {
  count: 3,
  empty: "",
  flag: true,
  nothing: null,
  outputs: { name: "it's", verdict: "ok" },
  text: "1",
};

const evaluate = (text: string) => {
  const parsed = parseCondition(text);
  if (!parsed.ok) {
    throw new Error(parsed.message);
  }
  return evaluateCondition(parsed.condition, context);
};

describe("evaluateCondition", () => {
  it.each([
    ["${{ outputs.verdict == 'ok' }}", true],
    ["${{ outputs.verdict != 'ok' }}", false],
    ["${{ outputs.name == 'it''s' }}", true],
    ["${{ count == 3 }}", true],
    ["${{ count == 3.5 }}", false],
    ["${{ count != -1 }}", true],
    ["${{ flag }}", true],
    ["${{ !flag }}", false],
    ["${{ !!flag }}", true],
    ["${{ nothing == null }}", true],
    ["${{ steps.missing.outputs.value == null }}", true],
    ["${{ true && false }}", false],
    ["${{ false || true }}", true],
    // && binds tighter than ||.
    ["${{ true || false && false }}", true],
    ["${{ (true || false) && false }}", false],
    ["${{ !false == true }}", true],
    ["${{outputs.verdict=='ok'&&flag}}", true],
  ])("evaluates %s", (text, value) => {
    expect(evaluate(text)).toEqual({ ok: true, value });
  });

  it.each([
    ["${{ text == 1 }}", false],
    ["${{ count == '3' }}", false],
    ["${{ empty == false }}", false],
    ["${{ nothing == false }}", false],
  ])("does not convert types in %s", (text, value) => {
    expect(evaluate(text)).toEqual({ ok: true, value });
  });

  it.each([
    ["${{ outputs.verdict }}", "Expected true or false but found string"],
    ["${{ count }}", "Expected true or false but found number"],
    ["${{ nothing }}", "Expected true or false but found null"],
    ["${{ !empty }}", "Expected true or false but found string"],
    ["${{ count && true }}", "Expected true or false but found number"],
    ["${{ flag && count }}", "Expected true or false but found number"],
    ["${{ false || empty }}", "Expected true or false but found string"],
  ])("needs true or false in %s", (text, message) => {
    expect(evaluate(text)).toEqual({ message, ok: false });
  });

  it("does not evaluate what && and || skip", () => {
    expect(evaluate("${{ false && count }}")).toEqual({ ok: true, value: false });
    expect(evaluate("${{ true || count }}")).toEqual({ ok: true, value: true });
  });

  it("does not read inherited members", () => {
    expect(evaluate("${{ outputs.constructor == null }}")).toEqual({ ok: true, value: true });
  });
});

describe("parseCondition", () => {
  it.each([
    ["outputs.ok == true", "A condition must be one ${{ }} expression: outputs.ok == true"],
    ["${{ }}", "Invalid condition: ${{ }}. Expected a value at the end"],
    ["${{ a == }}", "Invalid condition: ${{ a == }}. Expected a value at the end"],
    ["${{ (a }}", "Invalid condition: ${{ (a }}. Expected )"],
    ["${{ a) }}", "Invalid condition: ${{ a) }}. Unexpected )"],
    ["${{ a b }}", "Invalid condition: ${{ a b }}. Expected an operator"],
    ["${{ a == b == c }}", "Invalid condition: ${{ a == b == c }}. Unexpected =="],
    ["${{ a < 1 }}", "Invalid condition: ${{ a < 1 }}. Unexpected text: < 1"],
    ["${{ contains(a) }}", "Invalid condition: ${{ contains(a) }}. Unexpected ("],
    ["${{ a == 'b }}", "Invalid condition: ${{ a == 'b }}. Unexpected text: 'b"],
  ])("rejects %s", (text, message) => {
    expect(parseCondition(text)).toEqual({ message, ok: false });
  });

  it("lists the references", () => {
    const parsed = parseCondition("${{ !a.b && (c == 'x' || d.e != null) }}");

    expect(parsed.ok && conditionReferences(parsed.condition)).toEqual([
      ["a", "b"],
      ["c"],
      ["d", "e"],
    ]);
  });
});
