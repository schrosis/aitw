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
        { path: ["inputs", "title"], source: "${{ inputs.title }}", type: "reference" },
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

  it.each([
    "${{ inputs.title",
    "${{ }}",
    "${{ inputs..title }}",
    "${{ json(input) }}",
    "${{ inputs.a + 1 }}",
  ])("rejects %j", (text) => {
    expect(parseTemplate(text)).toMatchObject({ ok: false });
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

  it("skips unknown references and invalid templates", () => {
    expect(
      pickReferences(["${{ steps.missing.outputs.x }}", "${{ steps.fetch"], values, roots),
    ).toEqual({});
  });
});
