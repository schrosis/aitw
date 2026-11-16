import { describe, expect, it } from "vitest";

import { checkConditionTypes } from "./conditions.ts";
import { intermediateVersion } from "./schema.ts";
import type { Intermediate, ScriptStep, Transition } from "./schema.ts";
import { validateIntermediate } from "./validate.ts";

const script = (next: Transition, fields: Partial<ScriptStep> = {}): ScriptStep => ({
  inputs: {},
  next,
  outputs: { ok: "${{ result.ok }}" },
  run: "./run.sh",
  timeoutMs: 1000,
  type: "script",
  ...fields,
});

const toStep = (step: string): Transition => ({ step, type: "step" });

const branch = (...branches: { if?: string; to: string }[]): Transition => ({
  branches: branches.map(({ to, ...rest }) => ({
    ...rest,
    to: to === "end" ? { type: "end" } : { step: to, type: "step" },
  })),
  type: "branch",
});

const inputs: Intermediate["inputs"] = {
  dryRun: { required: false, type: "boolean" },
  force: { required: true, type: "boolean" },
  level: { options: ["low", "high"], required: false, type: "choice" },
  retries: { required: false, type: "number" },
  target: { required: false, type: "string" },
  verbose: { default: false, required: false, type: "boolean" },
};

/**
 * A workflow where `a` always runs before `notify`, and `review` runs before it only on one
 * branch.
 */
const workflow = (...conditions: string[]): Intermediate => ({
  inputs,
  start: "a",
  steps: {
    a: script(branch({ if: "${{ outputs.ok }}", to: "review" }, { to: "notify" })),
    notify: script(branch(...conditions.map((text) => ({ if: text, to: "end" })), { to: "end" })),
    review: script(toStep("notify"), { outputs: { approved: "${{ result.ok }}" } }),
  },
  version: intermediateVersion,
});

/** Returns the errors of an intermediate representation that passes validation. */
const errorsOf = (intermediate: Intermediate) => {
  expect(validateIntermediate(intermediate)).toMatchObject({ ok: true });
  return checkConditionTypes(intermediate);
};

const notifyPath = (index: number) => ["steps", "notify", "next", "branches", index, "if"];

describe("checkConditionTypes", () => {
  it.each([
    [
      "${{ steps.review.outputs.approved }}",
      "steps.review.outputs.approved is null when review has not run before notify. Compare it, such as steps.review.outputs.approved == true",
    ],
    [
      "${{ steps.review.visits[0].outputs.approved }}",
      "steps.review.visits[0].outputs.approved is null when review has not run before notify. Compare it, such as steps.review.visits[0].outputs.approved == true",
    ],
    [
      "${{ steps.review.visits[1].outputs.approved }}",
      "steps.review.visits[1].outputs.approved is null when review has not run 2 times before notify. Compare it, such as steps.review.visits[1].outputs.approved == true",
    ],
    [
      "${{ steps.a.visits[1].outputs.ok }}",
      "steps.a.visits[1].outputs.ok is null when a has not run 2 times before notify. Compare it, such as steps.a.visits[1].outputs.ok == true",
    ],
    [
      "${{ steps.a.visits[2].outputs.ok }}",
      "steps.a.visits[2].outputs.ok is null when a has not run 3 times before notify. Compare it, such as steps.a.visits[2].outputs.ok == true",
    ],
    [
      "${{ workflow.inputs.target }}",
      "workflow.inputs.target is a string, but a condition needs true or false",
    ],
    [
      "${{ workflow.inputs.level }}",
      "workflow.inputs.level is a string, but a condition needs true or false",
    ],
    [
      "${{ workflow.inputs.retries }}",
      "workflow.inputs.retries is a number, but a condition needs true or false",
    ],
    [
      "${{ workflow.inputs.dryRun }}",
      "workflow.inputs.dryRun is null when it is not given. Compare it, such as workflow.inputs.dryRun == true, or give it a default",
    ],
    ["${{ 'yes' }}", "'yes' is a string, but a condition needs true or false"],
    ["${{ 'it''s' }}", "'it''s' is a string, but a condition needs true or false"],
    ["${{ 1 }}", "1 is a number, but a condition needs true or false"],
    ["${{ null }}", "null is not true or false. A condition needs true or false"],
  ])("reports %s", (condition, message) => {
    expect(errorsOf(workflow(condition))).toEqual([{ message, path: notifyPath(0) }]);
  });

  it.each([
    "${{ steps.a.outputs.ok }}",
    "${{ steps.a.visits[0].outputs.ok }}",
    "${{ workflow.inputs.force }}",
    "${{ workflow.inputs.verbose }}",
    "${{ steps.review.outputs.approved == true }}",
    "${{ steps.review.outputs.approved != null }}",
    "${{ workflow.inputs.target == 'prod' }}",
    "${{ 'yes' == 1 }}",
    "${{ !(workflow.inputs.dryRun == true) }}",
    "${{ true }}",
    "${{ false }}",
    "${{ trim(workflow.inputs.target) }}",
    "${{ outputs.ok }}",
    "${{ result.ok }}",
    "${{ env.CI }}",
  ])("accepts %s", (condition) => {
    expect(errorsOf(workflow(condition))).toEqual([]);
  });

  it.each([
    ["!", "${{ !workflow.inputs.target }}"],
    ["&&", "${{ true && workflow.inputs.target }}"],
    ["||", "${{ workflow.inputs.target || false }}"],
    ["parentheses", "${{ (workflow.inputs.target) && true }}"],
  ])("checks an operand of %s", (_, condition) => {
    expect(errorsOf(workflow(condition))).toEqual([
      {
        message: "workflow.inputs.target is a string, but a condition needs true or false",
        path: notifyPath(0),
      },
    ]);
  });

  it("reports every value of a condition and every branch, in order", () => {
    expect(
      errorsOf(
        workflow(
          "${{ workflow.inputs.target && !steps.review.outputs.approved || 'no' == 1 }}",
          "${{ steps.review.outputs.approved == true }}",
          "${{ 1 }}",
        ),
      ),
    ).toEqual([
      {
        message: "workflow.inputs.target is a string, but a condition needs true or false",
        path: notifyPath(0),
      },
      {
        message:
          "steps.review.outputs.approved is null when review has not run before notify. Compare it, such as steps.review.outputs.approved == true",
        path: notifyPath(0),
      },
      { message: "1 is a number, but a condition needs true or false", path: notifyPath(2) },
    ]);
  });

  it("reports the outputs of the step itself, which are null on its first visit", () => {
    expect(
      errorsOf({
        inputs: {},
        start: "a",
        steps: {
          a: script(branch({ if: "${{ steps.a.outputs.ok }}", to: "a" }, { to: "end" })),
        },
        version: intermediateVersion,
      }),
    ).toEqual([
      {
        message:
          "steps.a.outputs.ok is null when a has not run before a. Compare it, such as steps.a.outputs.ok == true",
        path: ["steps", "a", "next", "branches", 0, "if"],
      },
    ]);
  });

  it("accepts the outputs of a step that always runs before in a loop", () => {
    expect(
      errorsOf({
        inputs: {},
        start: "implement",
        steps: {
          implement: script(toStep("review")),
          review: script(
            branch({ if: "${{ steps.implement.outputs.ok }}", to: "end" }, { to: "implement" }),
          ),
        },
        version: intermediateVersion,
      }),
    ).toEqual([]);
  });

  it("checks the conditions of a wait step", () => {
    expect(
      errorsOf({
        inputs,
        start: "ask",
        steps: {
          ask: {
            inputs: {},
            method: "terminal",
            next: branch({ if: "${{ workflow.inputs.target }}", to: "end" }, { to: "end" }),
            outputs: {},
            type: "wait",
            with: {},
          },
        },
        version: intermediateVersion,
      }),
    ).toEqual([
      {
        message: "workflow.inputs.target is a string, but a condition needs true or false",
        path: ["steps", "ask", "next", "branches", 0, "if"],
      },
    ]);
  });

  it("skips a condition that cannot be parsed", () => {
    expect(checkConditionTypes(workflow("${{ 1 == }}"))).toEqual([]);
  });
});
