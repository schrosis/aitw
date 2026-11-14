import { describe, expect, it } from "vitest";

import { createOutput, fixtureProject } from "../testing.ts";
import { validate } from "./validate.ts";

const run = async (name: string) => {
  const output = createOutput();
  const exitCode = await validate(name, { cwd: fixtureProject, ...output });
  return { exitCode, ...output.written };
};

describe("validate", () => {
  it("reports a valid definition", async () => {
    await expect(run("valid")).resolves.toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "valid: valid\n",
    });
  });

  it("skips transition checks when the schema is invalid", async () => {
    await expect(run("schema-error")).resolves.toEqual({
      exitCode: 1,
      stderr: `.ugoke/workflows/schema-error.yaml:1:10 version: Invalid input: expected "v0.1"\n`,
      stdout: "",
    });
  });

  it("reports a transition error with its location", async () => {
    await expect(run("transition-error")).resolves.toEqual({
      exitCode: 1,
      stderr:
        ".ugoke/workflows/transition-error.yaml:7:11 steps.fetch.next: Unknown step: report\n",
      stdout: "",
    });
  });

  it("reports invalid references with their locations", async () => {
    await expect(run("expression-error")).resolves.toEqual({
      exitCode: 1,
      stderr: [
        ".ugoke/workflows/expression-error.yaml:6:10 steps.fetch.run: Step fetch does not declare the input title: inputs.title",
        ".ugoke/workflows/expression-error.yaml:8:14 steps.fetch.outputs.title: Can reference only steps.<id>.outputs.<name>, steps.<id>.visits[n].outputs.<name>, workflow.inputs.<name>, inputs.<name>, result.exitCode, result.stdout, result.stderr, result.ok, or result.error: result.body",
        "",
      ].join("\n"),
      stdout: "",
    });
  });

  it("reports invalid input declarations and references", async () => {
    await expect(run("input-error")).resolves.toEqual({
      exitCode: 1,
      stderr: [
        ".ugoke/workflows/input-error.yaml:8:14 inputs.level.options: Duplicate option: low",
        ".ugoke/workflows/input-error.yaml:10:14 inputs.level.default: A required input cannot have a default",
        ".ugoke/workflows/input-error.yaml:10:14 inputs.level.default: Must be one of low, low",
        ".ugoke/workflows/input-error.yaml:16:16 steps.report.inputs.missing: The workflow does not declare the input missing: workflow.inputs.missing",
        ".ugoke/workflows/input-error.yaml:17:15 steps.report.inputs.nested: Cannot reference a field of a workflow input value: workflow.inputs.threshold.value",
        "",
      ].join("\n"),
      stdout: "",
    });
  });

  it("validates a wait step with the built-in terminal method", async () => {
    await expect(run("wait-valid")).resolves.toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "wait-valid: valid\n",
    });
  });

  it("reports invalid wait steps", async () => {
    await expect(run("wait-error")).resolves.toEqual({
      exitCode: 1,
      stderr: [
        ".ugoke/workflows/wait-error.yaml:11:17 steps.ask.with.schema.name.type: Invalid discriminator value. Expected 'string' | 'number' | 'boolean' | 'choice'",
        ".ugoke/workflows/wait-error.yaml:25:13 steps.later.method: Unknown wait method: slack. Available methods: terminal",
        ".ugoke/workflows/wait-error.yaml:8:16 steps.ask.with.message: Step greet does not run before ask: steps.greet.outputs.name",
        ".ugoke/workflows/wait-error.yaml:21:16 steps.confirm.outputs.missing: Step confirm does not declare the answer missing: result.missing",
        "",
      ].join("\n"),
      stdout: "",
    });
  });

  it("accepts an AI step of a built-in provider", async () => {
    await expect(run("ai-valid")).resolves.toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "ai-valid: valid\n",
    });
  });

  it("reports invalid references in env", async () => {
    await expect(run("env-error")).resolves.toEqual({
      exitCode: 1,
      stderr: [
        ".ugoke/workflows/env-error.yaml:3:14 env.FROM_STEP: The environment of the workflow can reference only workflow.inputs.<name>: steps.fetch.outputs.title",
        ".ugoke/workflows/env-error.yaml:9:16 steps.fetch.env.MISSING: Step fetch does not declare the input nothing: inputs.nothing",
        "",
      ].join("\n"),
      stdout: "",
    });
  });

  it("reports a workflow that cannot be resolved", async () => {
    await expect(run("missing")).resolves.toEqual({
      exitCode: 1,
      stderr: "Workflow not found: missing\n",
      stdout: "",
    });
  });
});
