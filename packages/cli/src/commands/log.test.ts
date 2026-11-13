import { tmpdir } from "node:os";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { createOutput, fixtureProject } from "../testing.ts";
import { log } from "./log.ts";
import type { LogOptions } from "./log.ts";
import { run } from "./run.ts";

describe("log", () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal({
      server: { executable: { path: inject("temporalCli"), type: "existing-path" } },
    });
  }, 120_000);

  afterAll(async () => {
    await environment?.teardown();
  });

  const server = () => ({ address: environment.address, type: "address" as const });

  /**
   * Runs a workflow of the fixture project, and resolves with its workflow ID as soon as it
   * starts.
   */
  const start = (name: string): { workflowId: Promise<string>; finished: Promise<number> } => {
    const { promise: workflowId, resolve } = Promise.withResolvers<string>();
    const finished = run(
      name,
      { fromAi: true, server: server(), signal: new AbortController().signal, version: "0.0.0" },
      {
        cwd: fixtureProject,
        stderr: () => {},
        stdout: (text) => {
          const line: unknown = JSON.parse(text);
          if (
            typeof line === "object" &&
            line !== null &&
            "type" in line &&
            line.type === "started" &&
            "workflowId" in line &&
            typeof line.workflowId === "string"
          ) {
            resolve(line.workflowId);
          }
        },
      },
    );
    return { finished, workflowId };
  };

  const show = async (options: Omit<LogOptions, "signal" | "version">, cwd = fixtureProject) => {
    const output = createOutput();
    const exitCode = await log(
      { server: server(), signal: new AbortController().signal, version: "0.0.0", ...options },
      { cwd, stderr: output.stderr, stdout: output.stdout },
    );
    return { exitCode, ...output.written };
  };

  it("shows the progress of a run that ended, with the output of its steps", async () => {
    const started = start("run-progress");
    const workflowId = await started.workflowId;
    await expect(started.finished).resolves.toBe(0);

    const result = await show({ workflowId });

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toMatch(
      /^count\n│ > for i in .*\n│ line 1\n│ line 2\n│ line 3\n✓ count {2}\d+\.\ds\n\nfinish\n│ > echo done\n│ done\n✓ finish {2}\d+\.\ds\n\n$/u,
    );
    // The last lines do not count the line that separates the steps.
    await expect(show({ tail: 2, workflowId })).resolves.toMatchObject({
      stdout: expect.stringMatching(/^│ done\n✓ finish {2}\d+\.\ds\n$/u) as unknown,
    });
    const json = await show({ json: true, tail: 1, workflowId });
    expect(JSON.parse(json.stdout)).toMatchObject({ step: "finish", type: "stepFinished" });
  }, 60_000);

  it("follows a run until it ends", async () => {
    const started = start("run-progress");
    const workflowId = await started.workflowId;

    const followed = await show({ follow: true, workflowId });

    expect(followed.exitCode).toBe(0);
    // The run ended while it was followed, so the progress shows its last step.
    expect(followed.stdout).toMatch(/│ line 3\n✓ count .*\n\nfinish\n.*\n│ done\n✓ finish/su);
    await expect(started.finished).resolves.toBe(0);
  }, 60_000);

  it("reports a run without progress in the project", async () => {
    await expect(show({ workflowId: "missing-1" })).resolves.toEqual({
      exitCode: 1,
      stderr: "No progress of missing-1 in this project\n",
      stdout: "",
    });
  }, 60_000);

  it("needs a project", async () => {
    await expect(show({ workflowId: "missing-1" }, tmpdir())).resolves.toMatchObject({
      exitCode: 1,
      stdout: "",
    });
  });
});
