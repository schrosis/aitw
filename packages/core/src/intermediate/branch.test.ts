import { describe, expect, it } from "vitest";

import { intermediateVersion } from "./schema.ts";
import type { Intermediate, ScriptStep, Transition } from "./schema.ts";
import { validateIntermediate } from "./validate.ts";

const script = (next: Transition, fields: Partial<ScriptStep> = {}): ScriptStep => ({
  inputs: {},
  next,
  outputs: {},
  run: "./run.sh",
  timeoutMs: 1000,
  type: "script",
  ...fields,
});

const toStep = (step: string): Transition => ({ step, type: "step" });
const end: Transition = { type: "end" };

const branch = (...branches: { if?: string; to: string }[]): Transition => ({
  branches: branches.map(({ to, ...rest }) => ({
    ...rest,
    to: to === "end" ? { type: "end" } : { step: to, type: "step" },
  })),
  type: "branch",
});

const workflow = (steps: Intermediate["steps"]): Intermediate => ({
  inputs: { level: { required: false, type: "string" } },
  start: "a",
  steps,
  version: intermediateVersion,
});

const errorsOf = (steps: Intermediate["steps"]) => {
  const result = validateIntermediate(workflow(steps));
  return result.ok ? [] : result.errors;
};

const condition = "${{ outputs.ok == true }}";
const outputs = { ok: "${{ result.exitCode }}" };

describe("validateIntermediate for branches", () => {
  it("accepts branches that join again", () => {
    expect(
      errorsOf({
        a: script(branch({ if: condition, to: "b" }, { to: "c" }), { outputs }),
        b: script(toStep("d")),
        c: script(toStep("d")),
        d: script(end),
      }),
    ).toEqual([]);
  });

  it("accepts a branch that ends the workflow", () => {
    expect(
      errorsOf({
        a: script(branch({ if: condition, to: "end" }, { to: "b" }), { outputs }),
        b: script(end),
      }),
    ).toEqual([]);
  });

  it("needs a last branch without a condition", () => {
    expect(
      errorsOf({ a: script(branch({ if: condition, to: "b" }), { outputs }), b: script(end) }),
    ).toEqual([
      {
        message:
          "The last branch must have no if, so that a branch is always taken. Use to: end to finish",
        path: ["steps", "a", "next", "branches", 0, "if"],
      },
    ]);
  });

  it("needs a condition on every other branch", () => {
    expect(errorsOf({ a: script(branch({ to: "b" }, { to: "end" })), b: script(end) })).toEqual([
      {
        message: "Only the last branch can have no if",
        path: ["steps", "a", "next", "branches", 0, "to"],
      },
    ]);
  });

  it("reports an unknown target and a transition to the start", () => {
    expect(
      errorsOf({ a: script(branch({ if: condition, to: "x" }, { to: "a" }), { outputs }) }),
    ).toEqual([
      { message: "Unknown step: x", path: ["steps", "a", "next", "branches", 0, "to", "step"] },
      {
        message: "Cannot transition to the start step: a",
        path: ["steps", "a", "next", "branches", 1, "to", "step"],
      },
    ]);
  });

  it("rejects a loop through a branch", () => {
    expect(
      errorsOf({
        a: script(toStep("b")),
        b: script(toStep("c")),
        c: script(branch({ if: condition, to: "b" }, { to: "end" }), { outputs }),
      }),
    ).toEqual([
      {
        message: "Cannot transition back to step b: loops are not supported yet",
        path: ["steps", "c", "next", "branches", 0, "to", "step"],
      },
    ]);
  });

  it.each([
    ["${{ outputs.ok == true }}"],
    ["${{ result.stdout == 'x' }}"],
    ["${{ steps.a.outputs.value == 'x' }}"],
    ["${{ workflow.inputs.level == 'info' }}"],
    ["${{ env.ANY_NAME == 'x' }}"],
  ])("lets a condition read %s", (text) => {
    expect(
      errorsOf({
        a: script(toStep("b"), { outputs: { value: "x" } }),
        b: script(branch({ if: text, to: "end" }, { to: "end" }), { outputs }),
      }),
    ).toEqual([]);
  });

  it.each([
    ["${{ outputs.missing == 1 }}", "Step a does not declare the output missing: outputs.missing"],
    ["${{ result.other == 1 }}", "Can reference only"],
    ["${{ inputs.value == 1 }}", "Can reference only"],
    ["${{ env.A.B == 1 }}", "Cannot reference a field of an environment variable: env.A.B"],
    ["${{ a < 1 }}", "Invalid condition"],
  ])("reports %s", (text, message) => {
    expect(
      errorsOf({ a: script(branch({ if: text, to: "end" }, { to: "end" }), { outputs }) }),
    ).toMatchObject([
      {
        message: expect.stringContaining(message) as unknown,
        path: ["steps", "a", "next", "branches", 0, "if"],
      },
    ]);
  });

  it("lets a step read a step that can run before it on another branch", () => {
    expect(
      errorsOf({
        a: script(branch({ if: condition, to: "b" }, { to: "c" }), { outputs }),
        b: script(toStep("d"), { outputs: { value: "x" } }),
        c: script(toStep("d")),
        d: script(end, { run: "${{ steps.b.outputs.value }}" }),
      }),
    ).toEqual([]);
  });

  it("does not let a step read a step that runs only after it", () => {
    expect(
      errorsOf({
        a: script(branch({ if: condition, to: "b" }, { to: "c" }), { outputs }),
        b: script(end, { run: "${{ steps.c.outputs.value }}" }),
        c: script(end, { outputs: { value: "x" } }),
      }),
    ).toMatchObject([
      { message: expect.stringContaining("Step c does not run before b") as unknown },
    ]);
  });
});
