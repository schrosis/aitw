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
      stderr: `.aitw/workflows/schema-error.yaml:1:10 version: Invalid input: expected "v0.1"\n`,
      stdout: "",
    });
  });

  it("reports a transition error with its location", async () => {
    await expect(run("transition-error")).resolves.toEqual({
      exitCode: 1,
      stderr: ".aitw/workflows/transition-error.yaml:7:11 steps.fetch.next: Unknown step: report\n",
      stdout: "",
    });
  });

  it("reports invalid references with their locations", async () => {
    await expect(run("expression-error")).resolves.toEqual({
      exitCode: 1,
      stderr: [
        ".aitw/workflows/expression-error.yaml:6:10 steps.fetch.run: Step fetch does not declare the input title: ${{ input.title }}",
        ".aitw/workflows/expression-error.yaml:8:14 steps.fetch.output.title: Output can reference only result.exitCode, result.stdout, or result.stderr: ${{ result.body }}",
        "",
      ].join("\n"),
      stdout: "",
    });
  });

  it("reports invalid input declarations and references", async () => {
    await expect(run("input-error")).resolves.toEqual({
      exitCode: 1,
      stderr: [
        ".aitw/workflows/input-error.yaml:8:14 input.level.options: Duplicate option: low",
        ".aitw/workflows/input-error.yaml:10:14 input.level.default: A required input cannot have a default",
        ".aitw/workflows/input-error.yaml:10:14 input.level.default: Must be one of low, low",
        ".aitw/workflows/input-error.yaml:16:16 steps.report.input.missing: The workflow does not declare the input missing: ${{ workflow.input.missing }}",
        ".aitw/workflows/input-error.yaml:17:15 steps.report.input.nested: Input cannot reference a field of a workflow input value: ${{ workflow.input.threshold.value }}",
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
