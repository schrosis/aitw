import { describe, expect, it } from "vitest";

import { intermediateVersion } from "./schema.ts";
import type { Intermediate, IntermediateStep } from "./schema.ts";
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

const withInput = (expression: string): Intermediate => ({
  ...workflow({ input: { value: expression } }),
  input: { level: { options: ["low"], required: false, type: "choice" } },
});

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

  it.each([
    [
      { input: { title: "${{ steps.report.output.title }}" } },
      "Step report does not run before report",
    ],
    [
      { input: { title: "${{ steps.fetch.output.missing }}" } },
      "Step fetch does not declare the output missing",
    ],
    [
      { input: { title: "${{ steps.fetch.output.title.length }}" } },
      "Input can reference only steps.<id>.output.<name>",
    ],
    [
      { input: { title: "${{ input.title }}" } },
      "Input can reference only steps.<id>.output.<name>",
    ],
  ])("rejects an invalid input reference", (report, message) => {
    expect(errorsOf(workflow(report))).toEqual([
      {
        message: expect.stringContaining(message) as unknown,
        path: ["steps", "report", "input", "title"],
      },
    ]);
  });

  it.each([
    ['./report.sh "${{ input.missing }}"', "Step report does not declare the input missing"],
    ['./report.sh "${{ steps.fetch.output.title }}"', "Run can reference only input.<name>"],
    ['./report.sh "${{ input.title.length }}"', "Run cannot reference a field of an input value"],
    ['./report.sh "${{ input.title', "Unterminated expression"],
  ])("rejects an invalid run reference", (run, message) => {
    expect(
      errorsOf(workflow({ input: { title: "${{ steps.fetch.output.title }}" }, run })),
    ).toEqual([
      { message: expect.stringContaining(message) as unknown, path: ["steps", "report", "run"] },
    ]);
  });

  it.each(["${{ result.missing }}", "${{ input.title }}", "${{ result.stdout.length }}"])(
    "rejects the output reference %j",
    (expression) => {
      expect(errorsOf(workflow({ output: { value: expression } }))).toEqual([
        {
          message: expect.stringContaining("Output can reference only") as unknown,
          path: ["steps", "report", "output", "value"],
        },
      ]);
    },
  );

  it("accepts and rejects references to the workflow input", () => {
    expect(errorsOf(withInput("${{ workflow.input.level }}"))).toEqual([]);
    expect(errorsOf(withInput("${{ workflow.input.missing }}"))).toEqual([
      {
        message: expect.stringContaining(
          "The workflow does not declare the input missing",
        ) as unknown,
        path: ["steps", "report", "input", "value"],
      },
    ]);
    expect(errorsOf(withInput("${{ workflow.input.level.length }}"))).toEqual([
      {
        message: expect.stringContaining("cannot reference a field of a workflow input") as unknown,
        path: ["steps", "report", "input", "value"],
      },
    ]);
  });

  it("does not let run reference the workflow input", () => {
    expect(
      errorsOf({
        ...workflow({ run: "echo ${{ workflow.input.level }}" }),
        input: { level: { options: ["low"], required: false, type: "choice" } },
      }),
    ).toMatchObject([{ path: ["steps", "report", "run"] }]);
  });
});
