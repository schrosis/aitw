import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { PassThrough, Readable } from "node:stream";

import { intermediateVersion } from "@aitw/core";
import { workflowCodeVersionMemoKey } from "@aitw/engine";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { acquireRunLock } from "../lock.ts";
import { listProjectRuns } from "../runs.ts";
import { projectHash, projectLockDirectory, projectMemoKey, workflowMemoKey } from "../state.ts";
import { createOutput, fixtureProject } from "../testing.ts";
import { cancel, resume } from "./resume.ts";
import { run } from "./run.ts";

const root = realpathSync(fixtureProject);

describe("resume and cancel", () => {
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

  /** Starts a workflow that waits for an answer, and detaches it. */
  const detachWaiting = async (): Promise<string> => {
    const controller = new AbortController();
    const output = createOutput();
    // The input never ends, so the wait step keeps waiting until the run detaches.
    const input = new PassThrough();
    const exitCode = await run(
      "wait-valid",
      { server: server(), signal: controller.signal, version: "0.0.0" },
      {
        cwd: fixtureProject,
        stderr: output.stderr,
        stdin: () => input,
        stdout: (text) => {
          output.stdout(text);
          if (text.startsWith("name (string, required): ")) {
            controller.abort();
          }
        },
      },
    );
    expect(exitCode).toBe(3);
    const runs = await listProjectRuns(environment.address, root);
    const detached = runs.find(({ name }) => name === "wait-valid");
    if (detached === undefined) {
      throw new Error("The detached run is not listed");
    }
    return detached.workflowId;
  };

  const execute = async (
    command: typeof resume,
    workflowId?: string,
    stdin = "",
    target: Parameters<typeof resume>[0]["server"] = server(),
  ) => {
    const output = createOutput();
    const exitCode = await command(
      { server: target, signal: new AbortController().signal, version: "0.0.0", workflowId },
      {
        cwd: fixtureProject,
        stderr: output.stderr,
        stdin: () => Readable.from([stdin]),
        stdout: output.stdout,
      },
    );
    return { exitCode, ...output.written };
  };

  it("lists the runs of the project and resumes the selected one", async () => {
    const workflowId = await detachWaiting();
    const runs = await listProjectRuns(environment.address, root);
    const index = runs.findIndex((candidate) => candidate.workflowId === workflowId) + 1;

    const result = await execute(resume, undefined, `${index}\nschrosis\ny\n`);

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain(
      `${index}. wait-valid  waiting at ask: Hello, what is your name?  started just now\n`,
    );
    // The resumed run shows the earlier progress, and continues from the wait step.
    expect(result.stdout).toMatch(
      /Select a run \(1-\d+\): \d+\nask\nHello, what is your name\?\nname \(string, required\): schrosis\n/u,
    );
    expect(result.stdout).toContain("Hello schrosis!!\n");
    expect(result.stdout).toContain("wait-valid: completed (ask, greet)\n");
  }, 60_000);

  it("cancels a run of the project", async () => {
    const workflowId = await detachWaiting();

    await expect(execute(cancel, workflowId)).resolves.toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "wait-valid: cancelled\n",
    });
    const runs = await listProjectRuns(environment.address, root);
    expect(runs.map((candidate) => candidate.workflowId)).not.toContain(workflowId);
  }, 60_000);

  it("does not resume a run that another process follows", async () => {
    const workflowId = await detachWaiting();
    const lock = acquireRunLock(projectLockDirectory(root), workflowId);
    try {
      const result = await execute(resume, workflowId);

      expect(result).toMatchObject({ exitCode: 1 });
      expect(result.stderr).toBe(
        `wait-valid: Another process (${process.pid}) already follows ${workflowId}\n`,
      );
    } finally {
      lock.release();
      await execute(cancel, workflowId);
    }
  }, 60_000);

  it("does not resume a run of another version, and terminates it to cancel it", async () => {
    const handle = await environment.client.workflow.start("aitw", {
      args: [
        {
          inputs: {},
          start: "wait",
          steps: {
            wait: {
              answers: {},
              inputs: {},
              method: "terminal",
              next: { type: "end" },
              outputs: {},
              type: "wait",
              with: { message: "Continue?" },
            },
          },
          version: intermediateVersion,
        },
        {},
      ],
      memo: {
        [projectMemoKey]: projectHash(root),
        [workflowCodeVersionMemoKey]: "0",
        [workflowMemoKey]: "old",
      },
      taskQueue: `aitw-${randomUUID()}`,
      workflowId: `old-${randomUUID()}`,
    });

    const listed = await execute(resume, undefined, "");
    expect(listed.stdout).toMatch(
      /\d+\. old {2}starting {2}started just now {2}\(started by another version of aitw\)\n/u,
    );

    const resumed = await execute(resume, handle.workflowId);
    expect(resumed).toMatchObject({ exitCode: 1 });
    expect(resumed.stderr).toContain("was started by workflow code version 0");
    expect(resumed.stderr).toContain("pass --force to try anyway");

    await expect(execute(cancel, handle.workflowId)).resolves.toEqual({
      exitCode: 0,
      stderr: "",
      stdout:
        "old: terminated instead of cancelled, because workflow code version 0 started it. Its running script, if any, stops at its next heartbeat\n",
    });
    await expect(handle.describe()).resolves.toMatchObject({ status: { name: "TERMINATED" } });
  }, 60_000);

  it("reports a run that is not running in the project", async () => {
    await expect(execute(resume, "missing-1")).resolves.toEqual({
      exitCode: 1,
      stderr: "No running run missing-1 in this project\n",
      stdout: "",
    });
  }, 60_000);

  it("needs --dev-db with --dev", async () => {
    await expect(execute(resume, undefined, "", { type: "dev" })).resolves.toEqual({
      exitCode: 1,
      stderr:
        "aitw resume needs --dev-db with --dev, because a development server without it keeps no runs\n",
      stdout: "",
    });
  });
});
