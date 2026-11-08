import { describe, expect, it } from "vitest";

import { evaluateExpression, parseTemplate, pickReferences } from "./index.ts";

const context = {
  input: { absent: null, count: 3, title: "hello" },
  result: { exitCode: 0, stdout: "out" },
  steps: { fetch: { output: { flag: true, items: ["a"], title: "hello" } } },
};

describe("parseTemplate", () => {
  it("splits text and references", () => {
    expect(parseTemplate("a ${{ input.title }} b")).toEqual({
      ok: true,
      template: [
        { type: "text", value: "a " },
        { path: ["input", "title"], source: "${{ input.title }}", type: "reference" },
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
    "${{ input.title",
    "${{ }}",
    "${{ input..title }}",
    "${{ json(input) }}",
    "${{ input.a + 1 }}",
  ])("rejects %j", (text) => {
    expect(parseTemplate(text)).toMatchObject({ ok: false });
  });
});

describe("parseTemplate names", () => {
  it.each(["${{ steps.my-step.output.x }}", "${{ input._private }}", "${{ input.1st }}"])(
    "rejects a name that workflows cannot define: %j",
    (text) => {
      expect(parseTemplate(text)).toMatchObject({ ok: false });
    },
  );
});

describe("evaluateExpression", () => {
  it("keeps the type of a single reference", () => {
    expect(evaluateExpression("${{ result.exitCode }}", context)).toEqual({ ok: true, value: 0 });
    expect(evaluateExpression("${{steps.fetch.output.flag}}", context)).toEqual({
      ok: true,
      value: true,
    });
    expect(evaluateExpression("${{ steps.fetch.output.items }}", context)).toEqual({
      ok: true,
      value: ["a"],
    });
  });

  it("embeds values into a string when mixed with text", () => {
    expect(evaluateExpression("${{ input.title }}-${{ input.count }}", context)).toEqual({
      ok: true,
      value: "hello-3",
    });
    expect(evaluateExpression("items: ${{ steps.fetch.output.items }}", context)).toEqual({
      ok: true,
      value: 'items: ["a"]',
    });
  });

  it("keeps null for a single reference and embeds it as an empty string", () => {
    expect(evaluateExpression("${{ input.absent }}", context)).toEqual({ ok: true, value: null });
    expect(evaluateExpression("[${{ input.absent }}]", context)).toEqual({
      ok: true,
      value: "[]",
    });
  });

  it("returns text without references as it is", () => {
    expect(evaluateExpression("plain", context)).toEqual({ ok: true, value: "plain" });
  });

  it.each([
    "${{ input.missing }}",
    "${{ steps.report.output.title }}",
    "${{ input.title.length }}",
  ])("reports the unknown reference %j", (text) => {
    expect(evaluateExpression(text, context)).toEqual({
      message: `Unknown reference: ${text}`,
      ok: false,
    });
  });

  it("does not read prototype members", () => {
    expect(evaluateExpression("${{ input.constructor }}", context)).toMatchObject({ ok: false });
    expect(evaluateExpression("${{ input.__proto__ }}", context)).toMatchObject({ ok: false });
  });

  it("reports a value that cannot be embedded", () => {
    expect(evaluateExpression("value: ${{ input.big }}", { input: { big: 1n } })).toMatchObject({
      ok: false,
    });
  });
});

describe("pickReferences", () => {
  const roots = new Set(["steps", "workflow"]);
  const values = {
    steps: {
      fetch: { output: { title: "hello", unused: "x" } },
      other: { output: { constructor: "c" } },
    },
    workflow: { input: { level: "high", unused: 1 } },
  };

  it("keeps only the referenced values under the given roots", () => {
    expect(
      pickReferences(
        [
          "${{ steps.fetch.output.title }}-${{ workflow.input.level }}",
          "${{ input.title }} ${{ result.stdout }}",
          "${{ steps.other.output.constructor }}",
        ],
        values,
        roots,
      ),
    ).toEqual({
      steps: { fetch: { output: { title: "hello" } }, other: { output: { constructor: "c" } } },
      workflow: { input: { level: "high" } },
    });
  });

  it("skips unknown references and invalid templates", () => {
    expect(
      pickReferences(["${{ steps.missing.output.x }}", "${{ steps.fetch"], values, roots),
    ).toEqual({});
  });
});
