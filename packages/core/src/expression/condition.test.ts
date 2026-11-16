import { describe, expect, it } from "vitest";

import {
  booleanOperands,
  conditionReferences,
  evaluateCondition,
  parseCondition,
} from "./condition.ts";

const context = {
  count: 3,
  padded: "  ok\n",
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

  it("reads an index of a list", () => {
    const parsed = parseCondition("${{ list[1].name == 'b' }}");

    expect(
      parsed.ok && evaluateCondition(parsed.condition, { list: [{ name: "a" }, { name: "b" }] }),
    ).toEqual({ ok: true, value: true });
    expect(parsed.ok && conditionReferences(parsed.condition)).toEqual([["list", "1", "name"]]);
  });

  it.each([
    ["${{ trim(padded) == 'ok' }}", true],
    ["${{ trim(padded) != 'ok' }}", false],
    ["${{ trim(empty) == '' && flag }}", true],
    ["${{ trim('ok') == trim(padded) }}", true],
  ])("calls a function in %s", (text, value) => {
    expect(evaluate(text)).toEqual({ ok: true, value });
  });

  it.each([
    ["${{ !trim(padded) }}", "Expected true or false but found string"],
    ["${{ trim(count) == 'ok' }}", "trim expects a string but got number"],
    ["${{ trim(steps.missing.outputs.value) == 'ok' }}", "trim expects a string but got null"],
    ["${{ trim(outputs.constructor) == 'ok' }}", "Unknown reference: outputs.constructor"],
  ])("fails on %s", (text, message) => {
    expect(evaluate(text)).toEqual({ message, ok: false });
  });

  it("does not call what && skips", () => {
    expect(evaluate("${{ false && trim(count) == 'ok' }}")).toEqual({ ok: true, value: false });
  });

  it("does not read inherited members", () => {
    expect(evaluate("${{ outputs.constructor == null }}")).toEqual({
      message: "Unknown reference: outputs.constructor",
      ok: false,
    });
  });
});

describe("evaluateCondition with references that cannot be read", () => {
  const runContext = {
    env: { DEPLOY_ENV: "prod" },
    result: { data: { items: ["a"], verdict: "ok" }, ok: true },
    steps: { review: { visits: [{ outputs: { approved: true } }] } },
  };

  const evaluateIn = (text: string, values: Readonly<Record<string, unknown>> = runContext) => {
    const parsed = parseCondition(text);
    if (!parsed.ok) {
      throw new Error(parsed.message);
    }
    return evaluateCondition(parsed.condition, values);
  };

  it.each([
    // A path that goes through null.
    ["${{ result.data.verdict == null }}", { result: { data: null, ok: false } }],
    // A step that has not run, and a visit that has not happened.
    ["${{ steps.deploy.outputs.version == null }}", runContext],
    ["${{ steps.review.visits[1].outputs.approved == null }}", runContext],
    // A variable that is not set.
    ["${{ env.DEPLOY_ENVV == null }}", runContext],
  ])("reads %s as null", (text, values) => {
    expect(evaluateIn(text, values)).toEqual({ ok: true, value: true });
  });

  it("compares an unset variable as unequal to a value", () => {
    expect(evaluateIn("${{ env.DEPLOY_ENVV == 'prod' }}")).toEqual({ ok: true, value: false });
    expect(evaluateIn("${{ env.DEPLOY_ENV == 'prod' }}")).toEqual({ ok: true, value: true });
  });

  it.each([
    ["${{ result.data.verdcit == 'ok' }}", "Unknown reference: result.data.verdcit"],
    ["${{ result.data.items[1] == null }}", "Unknown reference: result.data.items[1]"],
    ["${{ result.stdout == null }}", "Unknown reference: result.stdout"],
    // Only a name directly under env reads as null.
    ["${{ env.DEPLOY_ENV.name == null }}", "Unknown reference: env.DEPLOY_ENV.name"],
    ["${{ env.DEPLOY_ENVV.name == null }}", "Unknown reference: env.DEPLOY_ENVV.name"],
  ])("fails on %s", (text, message) => {
    expect(evaluateIn(text)).toEqual({ message, ok: false });
  });

  it("fails on env when the context has no env", () => {
    expect(evaluateIn("${{ env.CI == null }}", { result: runContext.result })).toEqual({
      message: "Unknown reference: env.CI",
      ok: false,
    });
  });

  it("reads the references in the arguments of a call in the same way", () => {
    expect(evaluateIn("${{ trim(result.data.verdcit) == 'ok' }}")).toEqual({
      message: "Unknown reference: result.data.verdcit",
      ok: false,
    });
    expect(evaluateIn("${{ trim(env.DEPLOY_ENVV) == 'prod' }}")).toEqual({
      message: "trim expects a string but got null",
      ok: false,
    });
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
    ["${{ a, b }}", "Invalid condition: ${{ a, b }}. Unexpected ,"],
    ["${{ trim(a }}", "Invalid condition: ${{ trim(a }}. Expected )"],
    ["${{ trim (a) }}", "Invalid condition: ${{ trim (a) }}. Unexpected ("],
    ["${{ true(a) }}", "Invalid condition: ${{ true(a) }}. Unexpected ("],
    ["${{ a == 'b }}", "Invalid condition: ${{ a == 'b }}. Unexpected text: 'b"],
  ])("rejects %s", (text, message) => {
    expect(parseCondition(text)).toEqual({ message, ok: false });
  });

  it("parses a call as a value", () => {
    expect(parseCondition("${{ !trim(a.b) }}")).toEqual({
      condition: {
        operand: {
          arguments: [{ path: ["a", "b"], type: "reference" }],
          name: "trim",
          type: "call",
        },
        type: "not",
      },
      ok: true,
    });
  });

  it("leaves an unknown function to validation", () => {
    expect(parseCondition("${{ contains(a) }}")).toMatchObject({ ok: true });
  });

  it("lists the references in arguments", () => {
    const parsed = parseCondition("${{ a == trim(b) && (trim(c.d) != e) }}");

    expect(parsed.ok && conditionReferences(parsed.condition)).toEqual([
      ["a"],
      ["b"],
      ["c", "d"],
      ["e"],
    ]);
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

const operandsOf = (text: string) => {
  const parsed = parseCondition(text);
  return parsed.ok ? booleanOperands(parsed.condition) : parsed.message;
};

describe("booleanOperands", () => {
  it("returns a condition that is one value", () => {
    expect(operandsOf("${{ trim(a) }}")).toEqual([
      { arguments: [{ path: ["a"], type: "reference" }], name: "trim", type: "call" },
    ]);
  });

  it("returns the operands of !, &&, and || from left to right", () => {
    expect(operandsOf("${{ !a && (b || !!'c') }}")).toEqual([
      { path: ["a"], type: "reference" },
      { path: ["b"], type: "reference" },
      { type: "literal", value: "c" },
    ]);
  });

  it("does not return the operands of comparisons", () => {
    expect(operandsOf("${{ a == 1 && !(b != null) || c }}")).toEqual([
      { path: ["c"], type: "reference" },
    ]);
  });
});
