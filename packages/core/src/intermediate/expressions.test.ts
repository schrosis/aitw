import { describe, expect, it } from "vitest";

import { intermediateVersion } from "./schema.ts";
import type { InputDeclaration } from "./declarations.ts";
import type { AiStep, Intermediate, ScriptStep } from "./schema.ts";
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
    expect(errorsOf(withField("outputs", "${{ result.ok }}"))).toEqual([]);
    expect(errorsOf(withField("outputs", "${{ result.error }}"))).toEqual([]);
    expect(errorsOf(withField("run", "${{ result.stdout }}"))).toMatchObject([
      { path: pathOf("run") },
    ]);
    for (const expression of ["${{ result.missing }}", "${{ result.stdout.length }}"]) {
      expect(errorsOf(withField("outputs", expression))).toEqual([
        {
          message: expect.stringContaining(
            "result.exitCode, result.stdout, result.stderr, result.ok, or result.error",
          ) as unknown,
          path: pathOf("outputs"),
        },
      ]);
    }
  });
});

describe("validateIntermediate calls in templates", () => {
  it.each([
    [
      "${{ trimm(result.stdout) }}",
      "Unknown function: trimm. Available functions: trim: ${{ trimm(result.stdout) }}",
    ],
    [
      "${{ trim(result.stdout, result.stderr) }}",
      "trim takes 1 argument but got 2: ${{ trim(result.stdout, result.stderr) }}",
    ],
    ["${{ trim(3) }}", "trim expects a string but got number: ${{ trim(3) }}"],
    ["${{ trim(trim(null)) }}", "trim expects a string but got null: ${{ trim(trim(null)) }}"],
    [
      "${{ trim(steps.fetch.outputs.titel) }}",
      "Step fetch does not declare the output titel: steps.fetch.outputs.titel",
    ],
    ["${{ trim(result.stdout }}", "Invalid expression: ${{ trim(result.stdout }}. Expected )"],
    ["${{ 'abc' }}", "Invalid expression: ${{ 'abc' }}. Use a reference or a function call"],
    ["${{ true }}", "Invalid expression: ${{ true }}. Use a reference or a function call"],
    [
      "${{ result.stdout == 'x' }}",
      "Invalid expression: ${{ result.stdout == 'x' }}. Operators can be used only in the if of next",
    ],
    [
      "${{ trim(result.stdout,) }}",
      "Invalid expression: ${{ trim(result.stdout,) }}. Expected a value after ,",
    ],
  ])("rejects %s", (expression, message) => {
    expect(errorsOf(withField("outputs", expression))).toEqual([
      { message, path: pathOf("outputs") },
    ]);
  });

  it("rejects a call of a function that does not exist", () => {
    expect(errorsOf(withField("outputs", "${{ json(result.stdout) }}"))).toEqual([
      {
        message: "Unknown function: json. Available functions: trim: ${{ json(result.stdout) }}",
        path: pathOf("outputs"),
      },
    ]);
  });

  it("checks the references in the arguments against the scope of the field", () => {
    expect(errorsOf(withField("inputs", "${{ trim(result.stdout) }}"))).toEqual([
      {
        message:
          "Can reference only steps.<id>.outputs.<name>, steps.<id>.visits[n].outputs.<name>, or workflow.inputs.<name>: result.stdout",
        path: pathOf("inputs"),
      },
    ]);
    expect(errorsOf(withField("run", "${{ trim(trim(steps.report.outputs.title)) }}"))).toEqual([
      {
        message: "Step report does not run before report: steps.report.outputs.title",
        path: pathOf("run"),
      },
    ]);
  });

  it("reports both a problem of a call and one of a reference", () => {
    expect(errorsOf(withField("outputs", "${{ trimm(result.missing) }}"))).toEqual([
      {
        message: "Unknown function: trimm. Available functions: trim: ${{ trimm(result.missing) }}",
        path: pathOf("outputs"),
      },
      {
        message: expect.stringMatching(/^Can reference only .*: result\.missing$/u) as unknown,
        path: pathOf("outputs"),
      },
    ]);
  });

  it("does not evaluate a call with references", () => {
    expect(errorsOf(withField("outputs", "${{ trim(result.exitCode) }}"))).toEqual([]);
  });

  it("accepts calls in every field", () => {
    const review: AiStep = {
      env: { TITLE: "${{ trim(inputs.title) }}" },
      inputs: { title: "${{ trim(steps.fetch.outputs.title) }}" },
      next: { step: "report", type: "step" },
      outputs: { summary: "${{ trim(result.data) }}" },
      prompt: "Review [${{ trim(inputs.title) }}] for ${{ trim(workflow.inputs.level) }}",
      provider: "claude-code",
      session: "reuse",
      timeoutMs: 1000,
      type: "ai",
      with: { tools: ["${{ trim(inputs.title) }}"] },
    };
    const intermediate: Intermediate = {
      env: { LEVEL: "${{ trim(workflow.inputs.level) }}" },
      inputs: { level },
      start: "fetch",
      steps: {
        fetch: step({ outputs: { title: "${{ trim(result.stdout) }}" } }, "review"),
        report: step(
          {
            env: { SUMMARY: "${{ trim(inputs.summary) }}" },
            inputs: { summary: "${{ trim(steps.review.outputs.summary) }}" },
            outputs: { value: "${{ trim(trim(result.stdout)) }}" },
            run: './report.sh "${{ trim(inputs.summary) }}"',
          },
          null,
        ),
        review,
      },
      version: intermediateVersion,
    };

    expect(errorsOf(intermediate)).toEqual([]);
  });

  it("checks the references in the arguments in the environment of the workflow", () => {
    expect(
      errorsOf({
        ...withField("outputs", "${{ result.stdout }}"),
        env: { TITLE: "${{ trim(steps.fetch.outputs.title) }}" },
      }),
    ).toEqual([
      {
        message:
          "The environment of the workflow can reference only workflow.inputs.<name>: steps.fetch.outputs.title",
        path: ["env", "TITLE"],
      },
    ]);
  });
});
