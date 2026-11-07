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

  it("reports a workflow that cannot be resolved", async () => {
    await expect(run("missing")).resolves.toEqual({
      exitCode: 1,
      stderr: "Workflow not found: missing\n",
      stdout: "",
    });
  });
});
