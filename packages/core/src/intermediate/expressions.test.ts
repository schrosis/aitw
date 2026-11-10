import { describe, expect, it } from "vitest";

import { intermediateVersion } from "./schema.ts";
import type { InputDeclaration } from "./declarations.ts";
import type { Intermediate, ScriptStep } from "./schema.ts";
import { validateIntermediate } from "./validate.ts";

const step = (fields: Partial<ScriptStep>, next: string | null): ScriptStep => ({
  inputs: {},
  next: next === null ? { type: "end" } : { step: next, type: "step" },
  outputs: {},
  run: "./run.sh",
  timeoutMs: 1000,
  type: "script",
  ...fields,
});

const workflow = (report: Partial<ScriptStep>, fetch: Partial<ScriptStep> = {}): Intermediate => ({
  inputs: {},
  start: "fetch",
  steps: {
    fetch: step({ outputs: { title: "${{ result.stdout }}" }, ...fetch }, "report"),
    report: step(report, null),
  },
  version: intermediateVersion,
});

const level: InputDeclaration = { options: ["low"], required: false, type: "choice" };

/** A workflow whose report step has the given field, with a declared workflow input. */
const withField = (field: "inputs" | "outputs" | "run", expression: string): Intermediate => ({
  ...workflow(
    field === "run"
      ? { inputs: { title: "${{ steps.fetch.outputs.title }}" }, run: expression }
      : { inputs: { title: "${{ steps.fetch.outputs.title }}" }, [field]: { value: expression } },
  ),
  inputs: { level },
});

const pathOf = (field: "inputs" | "outputs" | "run"): string[] =>
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
          inputs: { title: "${{ steps.fetch.outputs.title }}" },
          outputs: { code: "${{ result.exitCode }}", log: "[${{ result.stderr }}]" },
          run: './report.sh "${{ inputs.title }}"',
        }),
      ),
    ).toEqual([]);
  });

  describe.each(["inputs", "run", "outputs"] as const)("in %s", (field) => {
    it.each(["${{ steps.fetch.outputs.title }}", "${{ workflow.inputs.level }}"])(
      "accepts %s",
      (expression) => {
        expect(errorsOf(withField(field, expression))).toEqual([]);
      },
    );

    it.each([
      ["${{ steps.report.outputs.title }}", "Step report does not run before report"],
      ["${{ steps.fetch.outputs.missing }}", "Step fetch does not declare the output missing"],
      ["${{ steps.fetch.outputs.title.length }}", "Cannot reference a field of an output value"],
      ["${{ steps.fetch.title }}", "Can reference only steps.<id>.outputs.<name>"],
      ["${{ workflow.inputs.missing }}", "The workflow does not declare the input missing"],
      ["${{ workflow.inputs.level.length }}", "Cannot reference a field of a workflow input value"],
      ["${{ workflow.name }}", "Can reference only"],
      ["${{ env.HOME }}", "Can reference only"],
      ["${{ inputs.title", "Unterminated expression"],
    ])("rejects %s", (expression, message) => {
      expect(errorsOf(withField(field, expression))).toEqual([
        { message: expect.stringContaining(message) as unknown, path: pathOf(field) },
      ]);
    });
  });

  it("does not let input reference its own input or the script result", () => {
    for (const expression of ["${{ inputs.title }}", "${{ result.stdout }}"]) {
      expect(errorsOf(withField("inputs", expression))).toEqual([
        {
          message: expect.stringContaining(
            "Can reference only steps.<id>.outputs.<name>, steps.<id>.visits[n].outputs.<name>, or workflow.inputs.<name>:",
          ) as unknown,
          path: pathOf("inputs"),
        },
      ]);
    }
  });

  it.each(["run", "outputs"] as const)("lets %s reference its own input", (field) => {
    expect(errorsOf(withField(field, "${{ inputs.title }}"))).toEqual([]);
    expect(errorsOf(withField(field, "${{ inputs.missing }}"))).toEqual([
      {
        message: expect.stringContaining(
          "Step report does not declare the input missing",
        ) as unknown,
        path: pathOf(field),
      },
    ]);
    expect(errorsOf(withField(field, "${{ inputs.title.length }}"))).toEqual([
      {
        message: expect.stringContaining("Cannot reference a field of an input value") as unknown,
        path: pathOf(field),
      },
    ]);
  });

  it("lets only output reference the script result", () => {
    expect(errorsOf(withField("outputs", "${{ result.stdout }}"))).toEqual([]);
    expect(errorsOf(withField("run", "${{ result.stdout }}"))).toMatchObject([
      { path: pathOf("run") },
    ]);
    for (const expression of ["${{ result.missing }}", "${{ result.stdout.length }}"]) {
      expect(errorsOf(withField("outputs", expression))).toEqual([
        {
          message: expect.stringContaining(
            "result.exitCode, result.stdout, or result.stderr",
          ) as unknown,
          path: pathOf("outputs"),
        },
      ]);
    }
  });
});
