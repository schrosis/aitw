import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createOutput, fixtureProject } from "../testing.ts";
import { run } from "./run.ts";

describe("run", () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal();
  }, 120_000);

  afterAll(async () => {
    await environment?.teardown();
  });

  const execute = async (name: string, signal = new AbortController().signal) => {
    const output = createOutput();
    const exitCode = await run(
      name,
      { address: environment.address, signal },
      { cwd: fixtureProject, ...output },
    );
    return { exitCode, ...output.written };
  };

  it("runs the steps in the project root", async () => {
    await expect(execute("run-success")).resolves.toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "run-success: completed (check, finish)\n",
    });
  }, 60_000);

  it("reports a failed script", async () => {
    await expect(execute("run-failure")).resolves.toEqual({
      exitCode: 1,
      stderr: "run-failure: failed: Script exited with code 3\n",
      stdout: "",
    });
  }, 60_000);

  it("cancels the run when interrupted", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1000);

    await expect(execute("run-sleep", controller.signal)).resolves.toEqual({
      exitCode: 130,
      stderr: "run-sleep: cancelled\n",
      stdout: "",
    });
  }, 60_000);

  it("does not start an invalid workflow", async () => {
    await expect(execute("transition-error")).resolves.toMatchObject({ exitCode: 1, stdout: "" });
  }, 60_000);
});
