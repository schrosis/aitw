import { describe, expect, it } from "vitest";

import { evaluateExpression, parseTemplate, pickReferences } from "./index.ts";

const context = {
  inputs: { absent: null, count: 3, title: "hello" },
  result: { exitCode: 0, stdout: "out" },
  steps: { fetch: { outputs: { flag: true, items: ["a"], title: "hello" } } },
};

describe("parseTemplate", () => {
  it("splits text and references", () => {
    expect(parseTemplate("a ${{ inputs.title }} b")).toEqual({
      ok: true,
      template: [
        { type: "text", value: "a " },
        {
          expression: { path: ["inputs", "title"], type: "reference" },
          source: "${{ inputs.title }}",
          type: "expression",
        },
        { type: "text", value: " b" },
      ],
    });
  });

  it("parses text without references", () => {
    expect(parseTemplate("plain")).toEqual({
      ok: true,
      template: [{ type: "text", value: "plain" }],
    });
    expect(parseTemplate("")).toEqual({ ok: true, template: [] });
  });

  it.each(["${{ inputs.title", "${{ }}", "${{ inputs..title }}", "${{ inputs.a + 1 }}"])(
    "rejects %j",
    (text) => {
      expect(parseTemplate(text)).toMatchObject({ ok: false });
    },
  );
});

describe("parseTemplate calls", () => {
  it("parses a call with references, literals, and nested calls in its arguments", () => {
    expect(
      parseTemplate("${{ trim(steps.a.visits[0].outputs.v, 'x', 1, trim(result.stdout)) }}"),
    ).toEqual({
      ok: true,
      template: [
        {
          expression: {
            arguments: [
              { path: ["steps", "a", "visits", "0", "outputs", "v"], type: "reference" },
              { type: "literal", value: "x" },
              { type: "literal", value: 1 },
              {
                arguments: [{ path: ["result", "stdout"], type: "reference" }],
                name: "trim",
                type: "call",
              },
            ],
            name: "trim",
            type: "call",
          },
          source: "${{ trim(steps.a.visits[0].outputs.v, 'x', 1, trim(result.stdout)) }}",
          type: "expression",
        },
      ],
    });
  });

  it("parses a call of an unknown function, which validation reports", () => {
    expect(parseTemplate("${{ json(input) }}")).toEqual({
      ok: true,
      template: [
        {
          expression: {
            arguments: [{ path: ["input"], type: "reference" }],
            name: "json",
            type: "call",
          },
          source: "${{ json(input) }}",
          type: "expression",
        },
      ],
    });
  });

  it("reads a name without ( after it as a reference", () => {
    expect(parseTemplate("${{ trim.x }}")).toMatchObject({
      ok: true,
      template: [{ expression: { path: ["trim", "x"], type: "reference" } }],
    });
  });

  it("keeps the text around a call", () => {
    expect(parseTemplate("[${{ trim(inputs.title) }}]")).toMatchObject({
      ok: true,
      template: [
        { type: "text", value: "[" },
        { expression: { name: "trim", type: "call" }, type: "expression" },
        { type: "text", value: "]" },
      ],
    });
  });

  it.each([
    ["${{ trim (inputs.title) }}", "Expected the end"],
    ["${{ trim(inputs.title }}", "Expected )"],
    ["${{ trim(inputs.title, ) }}", "Expected a value after ,"],
    ["${{ trim(a == b) }}", "Operators can be used only in the if of next"],
    ["${{ inputs.a == 'x' }}", "Operators can be used only in the if of next"],
    ["${{ !inputs.a }}", "Operators can be used only in the if of next"],
    ["${{ inputs.a && inputs.b }}", "Operators can be used only in the if of next"],
    ["${{ inputs.a inputs.b }}", "Expected the end"],
    ["${{ trim(a) trim(b) }}", "Expected the end"],
    ["${{ 'abc' }}", "Use a reference or a function call"],
    ["${{ 3 }}", "Use a reference or a function call"],
    ["${{ true }}", "Use a reference or a function call"],
    ["${{ null }}", "Use a reference or a function call"],
    ["${{ }}", "Expected a value at the end"],
    ["${{ ) }}", "Unexpected )"],
  ])("rejects %j", (text, detail) => {
    expect(parseTemplate(text)).toEqual({
      message: `Invalid expression: ${text}. ${detail}`,
      ok: false,
    });
  });

  it("does not end an expression at }} in a string", () => {
    expect(parseTemplate("${{ trim('a}}b') }}!")).toEqual({
      ok: true,
      template: [
        {
          expression: {
            arguments: [{ type: "literal", value: "a}}b" }],
            name: "trim",
            type: "call",
          },
          source: "${{ trim('a}}b') }}",
          type: "expression",
        },
        { type: "text", value: "!" },
      ],
    });
  });

  it("reads '' as a quote in a string", () => {
    expect(parseTemplate("${{ trim('it''s }}') }}")).toMatchObject({
      ok: true,
      template: [
        {
          expression: { arguments: [{ type: "literal", value: "it's }}" }] },
          source: "${{ trim('it''s }}') }}",
        },
      ],
    });
    expect(parseTemplate("${{ trim('') }}")).toMatchObject({
      ok: true,
      template: [{ expression: { arguments: [{ type: "literal", value: "" }] } }],
    });
  });

  it("reports a string that is not closed", () => {
    expect(parseTemplate("${{ trim('a) }}")).toEqual({
      message: "Unterminated expression: ${{ trim('a) }}",
      ok: false,
    });
  });
});

describe("parseTemplate names", () => {
  it.each(["${{ steps.my-step.outputs.x }}", "${{ inputs._private }}", "${{ inputs.1st }}"])(
    "rejects a name that workflows cannot define: %j",
    (text) => {
      expect(parseTemplate(text)).toMatchObject({ ok: false });
    },
  );
});

describe("evaluateExpression", () => {
  it("keeps the type of a single reference", () => {
    expect(evaluateExpression("${{ result.exitCode }}", context)).toEqual({ ok: true, value: 0 });
    expect(evaluateExpression("${{steps.fetch.outputs.flag}}", context)).toEqual({
      ok: true,
      value: true,
    });
    expect(evaluateExpression("${{ steps.fetch.outputs.items }}", context)).toEqual({
      ok: true,
      value: ["a"],
    });
  });

  it("embeds values into a string when mixed with text", () => {
    expect(evaluateExpression("${{ inputs.title }}-${{ inputs.count }}", context)).toEqual({
      ok: true,
      value: "hello-3",
    });
    expect(evaluateExpression("items: ${{ steps.fetch.outputs.items }}", context)).toEqual({
      ok: true,
      value: 'items: ["a"]',
    });
  });

  it("keeps null for a single reference and embeds it as an empty string", () => {
    expect(evaluateExpression("${{ inputs.absent }}", context)).toEqual({ ok: true, value: null });
    expect(evaluateExpression("[${{ inputs.absent }}]", context)).toEqual({
      ok: true,
      value: "[]",
    });
  });

  it("reads a step that did not run as null", () => {
    expect(evaluateExpression("${{ steps.report.outputs.title }}", context)).toEqual({
      ok: true,
      value: null,
    });
    expect(evaluateExpression("[${{ steps.report.outputs.title }}]", context)).toEqual({
      ok: true,
      value: "[]",
    });
  });

  it("reads a field of null as null", () => {
    expect(evaluateExpression("${{ inputs.absent.name }}", context)).toEqual({
      ok: true,
      value: null,
    });
    expect(evaluateExpression("[${{ result.data.verdict }}]", { result: { data: null } })).toEqual({
      ok: true,
      value: "[]",
    });
  });

  it("takes an index only in brackets", () => {
    expect(parseTemplate("${{ steps.a.visits.0.outputs.v }}")).toMatchObject({ ok: false });
    expect(parseTemplate("${{ steps.a.visits[x].outputs.v }}")).toMatchObject({ ok: false });
  });

  it("reads an index of a list", () => {
    const visits = {
      steps: { a: { visits: [{ outputs: { v: "first" } }, { outputs: { v: "second" } }] } },
    };

    expect(evaluateExpression("${{ steps.a.visits[1].outputs.v }}", visits)).toEqual({
      ok: true,
      value: "second",
    });
    expect(evaluateExpression("${{ steps.a.visits[2].outputs.v }}", visits)).toEqual({
      ok: true,
      value: null,
    });
  });

  it("returns text without references as it is", () => {
    expect(evaluateExpression("plain", context)).toEqual({ ok: true, value: "plain" });
  });

  it.each(["${{ inputs.missing }}", "${{ inputs.title.length }}"])(
    "reports the unknown reference %j",
    (text) => {
      expect(evaluateExpression(text, context)).toEqual({
        message: `Unknown reference: ${text}`,
        ok: false,
      });
    },
  );

  it("does not read prototype members", () => {
    expect(evaluateExpression("${{ inputs.constructor }}", context)).toMatchObject({ ok: false });
    expect(evaluateExpression("${{ inputs.__proto__ }}", context)).toMatchObject({ ok: false });
  });

  it("reports a value that cannot be embedded", () => {
    expect(evaluateExpression("value: ${{ inputs.big }}", { inputs: { big: 1n } })).toMatchObject({
      ok: false,
    });
  });
});

describe("evaluateExpression with white space around a single expression", () => {
  const values = {
    result: { exitCode: 0 },
    workflow: { inputs: { dryRun: true } },
  };

  it.each([
    ["${{ result.exitCode }}", 0],
    ["${{ result.exitCode }}\n", 0],
    ["  ${{ workflow.inputs.dryRun }}  ", true],
    ["code: ${{ result.exitCode }}", "code: 0"],
    ["${{ result.exitCode }} ${{ workflow.inputs.dryRun }}", "0 true"],
  ])("evaluates %j to %j", (text, value) => {
    expect(evaluateExpression(text, values)).toEqual({ ok: true, value });
  });

  it.each([
    ["a space", " "],
    ["a tab", "\t"],
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["U+00A0", "\u00a0"],
    ["U+3000", "\u3000"],
  ])("drops %s around the expression", (_name, space) => {
    expect(evaluateExpression(`${space}\${{ result.exitCode }}${space}`, values)).toEqual({
      ok: true,
      value: 0,
    });
  });

  it("keeps the type of a value that is not a string, number, or boolean", () => {
    expect(evaluateExpression("\n${{ steps.fetch.outputs.items }}\n", context)).toEqual({
      ok: true,
      value: ["a"],
    });
    expect(evaluateExpression(" ${{ inputs.absent }} ", context)).toEqual({
      ok: true,
      value: null,
    });
  });

  it.each([
    ["a character that is not white space", "${{ result.exitCode }}\n.", "0\n."],
    ["a zero width space, which trim keeps", "${{ result.exitCode }}\u200b", "0\u200b"],
    ["a second expression", "${{ result.exitCode }}\n${{ result.exitCode }}\n", "0\n0\n"],
  ])("embeds the value into a string with %s", (_name, text, value) => {
    expect(evaluateExpression(text, values)).toEqual({ ok: true, value });
  });

  it("applies the same rule to calls", () => {
    const strings = { inputs: { title: " hello " } };

    expect(evaluateExpression("\n  ${{ trim(inputs.title) }}\r\n", strings)).toEqual({
      ok: true,
      value: "hello",
    });
    expect(evaluateExpression("[${{ trim(inputs.title) }}]\n", strings)).toEqual({
      ok: true,
      value: "[hello]\n",
    });
    expect(
      evaluateExpression("${{ trim(inputs.title) }} ${{ trim(inputs.title) }}", strings),
    ).toEqual({ ok: true, value: "hello hello" });
  });

  it("keeps text without expressions as it is", () => {
    expect(evaluateExpression("  \n", values)).toEqual({ ok: true, value: "  \n" });
  });
});

describe("evaluateExpression calls", () => {
  const values = {
    inputs: { count: 3, title: "  hello \n" },
    result: { stdout: " out\n" },
  };

  it("keeps the string of a single call", () => {
    expect(evaluateExpression("${{ trim(inputs.title) }}", values)).toEqual({
      ok: true,
      value: "hello",
    });
    expect(evaluateExpression("${{ trim(trim(' a ')) }}", values)).toEqual({
      ok: true,
      value: "a",
    });
  });

  it("embeds the value of a call when mixed with text", () => {
    expect(
      evaluateExpression("[${{ trim(inputs.title) }}] ${{ trim(result.stdout) }}", values),
    ).toEqual({ ok: true, value: "[hello] out" });
  });

  it("fails on an argument that is not a string", () => {
    expect(evaluateExpression("${{ trim(inputs.count) }}", values)).toEqual({
      message: "trim expects a string but got number: ${{ trim(inputs.count) }}",
      ok: false,
    });
  });

  it("fails on a step that did not run, which reads as null", () => {
    expect(evaluateExpression("${{ trim(steps.report.outputs.title) }}", values)).toEqual({
      message: "trim expects a string but got null: ${{ trim(steps.report.outputs.title) }}",
      ok: false,
    });
    expect(evaluateExpression("[${{ trim(steps.report.outputs.title) }}]", values)).toEqual({
      message: "trim expects a string but got null: ${{ trim(steps.report.outputs.title) }}",
      ok: false,
    });
  });

  it("reports an unknown reference in an argument with the whole expression", () => {
    expect(evaluateExpression("a ${{ trim(inputs.missing) }}", values)).toEqual({
      message: "Unknown reference: ${{ trim(inputs.missing) }}",
      ok: false,
    });
  });

  it("guards an unknown function and a wrong number of arguments", () => {
    expect(evaluateExpression("${{ json(inputs.title) }}", values)).toEqual({
      message: "Unknown function: json: ${{ json(inputs.title) }}",
      ok: false,
    });
    expect(evaluateExpression("${{ trim(inputs.title, inputs.title) }}", values)).toEqual({
      message: "trim takes 1 argument but got 2: ${{ trim(inputs.title, inputs.title) }}",
      ok: false,
    });
  });
});

describe("pickReferences", () => {
  const roots = new Set(["steps", "workflow"]);
  const values = {
    steps: {
      fetch: { outputs: { title: "hello", unused: "x" } },
      other: { outputs: { constructor: "c" } },
    },
    workflow: { inputs: { level: "high", unused: 1 } },
  };

  it("keeps only the referenced values under the given roots", () => {
    expect(
      pickReferences(
        [
          "${{ steps.fetch.outputs.title }}-${{ workflow.inputs.level }}",
          "${{ inputs.title }} ${{ result.stdout }}",
          "${{ steps.other.outputs.constructor }}",
        ],
        values,
        roots,
      ),
    ).toEqual({
      steps: { fetch: { outputs: { title: "hello" } }, other: { outputs: { constructor: "c" } } },
      workflow: { inputs: { level: "high" } },
    });
  });

  it.each([
    [["${{ steps.review.outputs.data }}", "${{ steps.review.outputs.data.verdict }}"], []],
    [["${{ steps.review.outputs.data.verdict }}", "${{ steps.review.outputs.data }}"], []],
    [[], [["steps", "review", "outputs", "data", "verdict"]]],
  ])("keeps a null that references go through, from %j %j", (texts, paths) => {
    const picked = pickReferences(
      texts,
      { steps: { review: { outputs: { data: null } } } },
      roots,
      paths,
    );

    expect(picked).toEqual({ steps: { review: { outputs: { data: null } } } });
  });

  it("picks the references in the arguments of calls", () => {
    expect(
      pickReferences(
        [
          "${{ trim(steps.fetch.outputs.title) }}",
          "[${{ trim(trim(workflow.inputs.level)) }}] ${{ trim(inputs.title) }}",
        ],
        values,
        roots,
      ),
    ).toEqual({
      steps: { fetch: { outputs: { title: "hello" } } },
      workflow: { inputs: { level: "high" } },
    });
  });

  it("skips unknown references and invalid templates", () => {
    expect(
      pickReferences(["${{ steps.missing.outputs.x }}", "${{ steps.fetch"], values, roots),
    ).toEqual({});
  });
});
