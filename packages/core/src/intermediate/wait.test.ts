import { describe, expect, it } from "vitest";

import { intermediateVersion } from "./schema.ts";
import type { Intermediate, WaitStep } from "./schema.ts";
import { validateIntermediate } from "./validate.ts";

const wait = (fields: Partial<WaitStep> = {}): WaitStep => ({
  answers: { name: { required: true, type: "string" } },
  inputs: {},
  method: "terminal",
  next: { step: "greet", type: "step" },
  outputs: { name: "${{ result.name }}" },
  type: "wait",
  with: { message: "Hello ${{ workflow.inputs.greeting }}" },
  ...fields,
});

const workflow = (ask: WaitStep, greetInputs: Record<string, string> = {}): Intermediate => ({
  inputs: { greeting: { required: false, type: "string" } },
  start: "ask",
  steps: {
    ask,
    greet: {
      inputs: greetInputs,
      next: { type: "end" },
      outputs: {},
      run: "echo hello",
      timeoutMs: 1000,
      type: "script",
    },
  },
  version: intermediateVersion,
});

const errorsOf = (intermediate: Intermediate) => {
  const result = validateIntermediate(intermediate);
  return result.ok ? [] : result.errors;
};

describe("validateIntermediate wait steps", () => {
  it("accepts a wait step whose answers later steps reference", () => {
    expect(errorsOf(workflow(wait(), { name: "${{ steps.ask.outputs.name }}" }))).toEqual([]);
  });

  it("checks references in every string of with", () => {
    expect(
      errorsOf(
        workflow(
          wait({
            with: {
              list: ["${{ steps.greet.outputs.x }}"],
              nested: { text: "${{ workflow.inputs.missing }}" },
            },
          }),
        ),
      ),
    ).toEqual([
      {
        message: expect.stringContaining("Step greet does not run before ask") as unknown,
        path: ["steps", "ask", "with", "list", 0],
      },
      {
        message: expect.stringContaining("does not declare the input missing") as unknown,
        path: ["steps", "ask", "with", "nested", "text"],
      },
    ]);
  });

  it("lets outputs reference only the declared answers", () => {
    expect(errorsOf(workflow(wait({ outputs: { x: "${{ result.missing }}" } })))).toEqual([
      {
        message: expect.stringContaining("Step ask does not declare the answer missing") as unknown,
        path: ["steps", "ask", "outputs", "x"],
      },
    ]);
  });

  it("lets outputs reference any result of a method without answers", () => {
    const { answers: _answers, ...withoutAnswers } = wait({
      outputs: { conclusion: "${{ result.check.conclusion }}" },
    });

    expect(errorsOf(workflow(withoutAnswers))).toEqual([]);
  });

  it("checks the answers like other declarations", () => {
    expect(
      errorsOf(
        workflow(
          wait({
            answers: {
              level: { default: "c", options: ["a", "a"], required: false, type: "choice" },
              name: { default: "${{ inputs.x }}", required: false, type: "string" },
            },
            outputs: {},
          }),
        ),
      ),
    ).toEqual([
      { message: "Duplicate option: a", path: ["steps", "ask", "answers", "level", "options"] },
      {
        message: "Must be one of a, a",
        path: ["steps", "ask", "answers", "level", "default"],
      },
      {
        message: "Defaults and options of answers cannot contain expressions",
        path: ["steps", "ask", "answers", "name"],
      },
    ]);
  });
});
