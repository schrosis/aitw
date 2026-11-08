import { describe, expect, it } from "vitest";

import { intermediateVersion } from "./schema.ts";
import type { InputDeclaration, Intermediate, IntermediateStep } from "./schema.ts";
import { validateIntermediate } from "./validate.ts";

const step = (fields: Partial<IntermediateStep>, next: string | null): IntermediateStep => ({
  input: {},
  next: next === null ? { type: "end" } : { step: next, type: "step" },
  output: {},
  run: "./run.sh",
  timeoutMs: 1000,
  type: "script",
  ...fields,
});

const workflow = (
  report: Partial<IntermediateStep>,
  fetch: Partial<IntermediateStep> = {},
): Intermediate => ({
  input: {},
  start: "fetch",
  steps: {
    fetch: step({ output: { title: "${{ result.stdout }}" }, ...fetch }, "report"),
    report: step(report, null),
  },
  version: intermediateVersion,
});

const level: InputDeclaration = { options: ["low"], required: false, type: "choice" };

/** A workflow whose report step has the given field, with a declared workflow input. */
const withField = (field: "input" | "output" | "run", expression: string): Intermediate => ({
  ...workflow(
    field === "run"
      ? { input: { title: "${{ steps.fetch.output.title }}" }, run: expression }
      : { input: { title: "${{ steps.fetch.output.title }}" }, [field]: { value: expression } },
  ),
  input: { level },
});

const pathOf = (field: "input" | "output" | "run"): string[] =>
  field === "run" ? ["steps", "report", "run"] : ["steps", "report", field, "value"];

const errorsOf = (intermediate: Intermediate) => {
  const result = validateIntermediate(intermediate);
  return result.ok ? [] : result.errors;
};

describe("validateIntermediate expressions", () => {
  it("accepts references to earlier outputs, own input, and the script result", () => {
    expect(
      errorsOf(
        workflow({
          input: { title: "${{ steps.fetch.output.title }}" },
          output: { code: "${{ result.exitCode }}", log: "[${{ result.stderr }}]" },
          run: './report.sh "${{ input.title }}"',
        }),
      ),
    ).toEqual([]);
  });

  describe.each(["input", "run", "output"] as const)("in %s", (field) => {
    it.each(["${{ steps.fetch.output.title }}", "${{ workflow.input.level }}"])(
      "accepts %s",
      (expression) => {
        expect(errorsOf(withField(field, expression))).toEqual([]);
      },
    );

    it.each([
      ["${{ steps.report.output.title }}", "Step report does not run before report"],
      ["${{ steps.fetch.output.missing }}", "Step fetch does not declare the output missing"],
      ["${{ steps.fetch.output.title.length }}", "Cannot reference a field of an output value"],
      ["${{ steps.fetch.title }}", "Can reference only steps.<id>.output.<name>"],
      ["${{ workflow.input.missing }}", "The workflow does not declare the input missing"],
      ["${{ workflow.input.level.length }}", "Cannot reference a field of a workflow input value"],
      ["${{ workflow.name }}", "Can reference only"],
      ["${{ env.HOME }}", "Can reference only"],
      ["${{ input.title", "Unterminated expression"],
    ])("rejects %s", (expression, message) => {
      expect(errorsOf(withField(field, expression))).toEqual([
        { message: expect.stringContaining(message) as unknown, path: pathOf(field) },
      ]);
    });
  });

  it("does not let input reference its own input or the script result", () => {
    for (const expression of ["${{ input.title }}", "${{ result.stdout }}"]) {
      expect(errorsOf(withField("input", expression))).toEqual([
        {
          message: expect.stringContaining(
            "Can reference only steps.<id>.output.<name>, or workflow.input.<name>:",
          ) as unknown,
          path: pathOf("input"),
        },
      ]);
    }
  });

  it.each(["run", "output"] as const)("lets %s reference its own input", (field) => {
    expect(errorsOf(withField(field, "${{ input.title }}"))).toEqual([]);
    expect(errorsOf(withField(field, "${{ input.missing }}"))).toEqual([
      {
        message: expect.stringContaining(
          "Step report does not declare the input missing",
        ) as unknown,
        path: pathOf(field),
      },
    ]);
    expect(errorsOf(withField(field, "${{ input.title.length }}"))).toEqual([
      {
        message: expect.stringContaining("Cannot reference a field of an input value") as unknown,
        path: pathOf(field),
      },
    ]);
  });

  it("lets only output reference the script result", () => {
    expect(errorsOf(withField("output", "${{ result.stdout }}"))).toEqual([]);
    expect(errorsOf(withField("run", "${{ result.stdout }}"))).toMatchObject([
      { path: pathOf("run") },
    ]);
    for (const expression of ["${{ result.missing }}", "${{ result.stdout.length }}"]) {
      expect(errorsOf(withField("output", expression))).toEqual([
        {
          message: expect.stringContaining(
            "result.exitCode, result.stdout, or result.stderr",
          ) as unknown,
          path: pathOf("output"),
        },
      ]);
    }
  });
});
