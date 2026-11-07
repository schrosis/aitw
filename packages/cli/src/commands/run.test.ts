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
    const result = await execute("run-success");

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toMatch(
      /^▶ check\ntest -d \.aitw\n✓ check \(\d+\.\ds\)\n▶ finish\ntrue\n✓ finish \(\d+\.\ds\)\nrun-success: completed \(check, finish\)\n$/u,
    );
  }, 60_000);

  it("shows script output as it runs", async () => {
    const result = await execute("run-output");

    expect(result).toMatchObject({ exitCode: 0, stderr: "fuga\n" });
    expect(result.stdout).toMatch(
      /^▶ firstStep\necho "hoge"\nhoge\n✓ firstStep \(\d+\.\ds\)\n▶ secondStep\necho "fuga" >&2\n✓ secondStep \(\d+\.\ds\)\nrun-output: completed \(firstStep, secondStep\)\n$/u,
    );
  }, 60_000);

  it("reports a failed script", async () => {
    const result = await execute("run-failure");

    expect(result).toMatchObject({
      exitCode: 1,
      stderr: "run-failure: failed: Script exited with code 3\n",
    });
    expect(result.stdout).toMatch(
      /^▶ fail\nexit 3\n✗ fail: Script exited with code 3 \(\d+\.\ds\)\n$/u,
    );
  }, 60_000);

  it("cancels the run when interrupted", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1000);

    const result = await execute("run-sleep", controller.signal);

    expect(result).toMatchObject({ exitCode: 130, stderr: "run-sleep: cancelled\n" });
    // The cancelled step may finish after the workflow reports the cancellation.
    expect(result.stdout).toMatch(/^▶ wait\nsleep 30\n(■ wait: cancelled \(\d+\.\ds\)\n)?$/u);
  }, 60_000);

  it("does not start an invalid workflow", async () => {
    await expect(execute("transition-error")).resolves.toMatchObject({ exitCode: 1, stdout: "" });
  }, 60_000);
});
