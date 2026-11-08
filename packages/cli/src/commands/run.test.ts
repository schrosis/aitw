import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { createOutput, fixtureProject } from "../testing.ts";
import { run } from "./run.ts";

describe("run", () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal({
      server: { executable: { path: inject("temporalCli"), type: "existing-path" } },
    });
  }, 120_000);

  afterAll(async () => {
    await environment?.teardown();
  });

  const execute = async (
    name: string,
    signal = new AbortController().signal,
    onStdout: (text: string) => void = () => {},
    input?: string,
  ) => {
    const output = createOutput();
    const exitCode = await run(
      name,
      { input, server: { address: environment.address, type: "address" }, signal },
      {
        cwd: fixtureProject,
        stderr: output.stderr,
        stdout: (text) => {
          output.stdout(text);
          onStdout(text);
        },
      },
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

  it("passes values between steps", async () => {
    const result = await execute("run-values");

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain('test "hello" = hello && echo "title=hello"\ntitle=hello\n');
  }, 60_000);

  it("passes the workflow input with defaults applied", async () => {
    const result = await execute("run-input", undefined, undefined, '{"level": "high"}');

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("threshold=1.5 level=high note=[]\n");
  }, 60_000);

  it("reports invalid workflow input without starting the workflow", async () => {
    await expect(
      execute("run-input", undefined, undefined, '{"level": "mid", "extra": 1}'),
    ).resolves.toEqual({
      exitCode: 1,
      stderr:
        "run-input: workflow.input.extra: Unknown input\nrun-input: workflow.input.level: Must be one of low, high\n",
      stdout: "",
    });
  }, 60_000);

  it("rejects workflow input over the size limit without starting the workflow", async () => {
    const note = "x".repeat(600 * 1024);
    await expect(
      execute("run-input", undefined, undefined, JSON.stringify({ level: "high", note })),
    ).resolves.toEqual({
      exitCode: 1,
      stderr: expect.stringMatching(
        /^run-input: workflow\.input is \d+ bytes, which exceeds the limit of 524288 bytes\n$/u,
      ) as unknown,
      stdout: "",
    });
  }, 60_000);

  it("reports unreadable workflow input", async () => {
    await expect(execute("run-input", undefined, undefined, "input.yaml")).resolves.toMatchObject({
      exitCode: 1,
      stderr: "run-input: --input must be a JSON object or the path of a .json file: input.yaml\n",
    });
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
    // Interrupt once the script has started, because starting a Worker can take a while in CI.
    const result = await execute("run-sleep", controller.signal, (text) => {
      if (text.startsWith("▶ wait")) {
        controller.abort();
      }
    });

    expect(result).toMatchObject({ exitCode: 130, stderr: "run-sleep: cancelled\n" });
    // The cancelled step may finish after the workflow reports the cancellation.
    expect(result.stdout).toMatch(/^▶ wait\nsleep 30\n(■ wait: cancelled \(\d+\.\ds\)\n)?$/u);
  }, 60_000);

  it("does not start an invalid workflow", async () => {
    await expect(execute("transition-error")).resolves.toMatchObject({ exitCode: 1, stdout: "" });
  }, 60_000);
});
