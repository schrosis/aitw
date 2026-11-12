import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";

import { startWorker } from "@aitw/engine";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { loadEncryptionKey } from "../encryption.ts";
import { listProjectRuns } from "../runs.ts";
import { createOutput, fixtureProject } from "../testing.ts";
import { answerInboxCommand, listInboxCommand } from "./inbox.ts";
import { cancel } from "./resume.ts";
import { run } from "./run.ts";

const root = realpathSync(fixtureProject);

describe("inbox", () => {
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
  const signal = new AbortController().signal;

  /** Starts a workflow that waits for an answer, and detaches it. */
  const detachWaiting = async (): Promise<{ workflowId: string; taskQueue: string }> => {
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
    return detached;
  };

  const list = async (cwd = fixtureProject) => {
    const output = createOutput();
    const exitCode = await listInboxCommand(
      { server: server(), signal, version: "0.0.0" },
      { cwd, stderr: output.stderr, stdout: output.stdout },
    );
    return { exitCode, ...output.written };
  };

  const answer = async (workflowId: string, values: string) => {
    const output = createOutput();
    const exitCode = await answerInboxCommand(
      { server: server(), signal, step: "ask", values, version: "0.0.0", visit: 0, workflowId },
      { cwd: fixtureProject, stderr: output.stderr, stdout: output.stdout },
    );
    return { exitCode, ...output.written };
  };

  const cancelRun = async (workflowId: string): Promise<void> => {
    const output = createOutput();
    await cancel(
      { server: server(), signal, version: "0.0.0", workflowId },
      { cwd: fixtureProject, stderr: output.stderr, stdout: output.stdout },
    );
  };

  it("lists a question with the command that answers it", async () => {
    const { taskQueue, workflowId } = await detachWaiting();
    // A Worker serves the run, as the resident process does.
    const worker = await startWorker({
      address: environment.address,
      encryptionKey: loadEncryptionKey(),
      eventLog: { append: () => {}, read: async () => ({ cursor: "", events: [] }) },
      scriptRunner: { run: async () => ({ exitCode: 0, signal: null, stderr: "", stdout: "" }) },
      taskQueue,
    });
    try {
      const result = await list();

      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(result.stdout).toContain(
        [
          `${workflowId}  wait-valid  ask (visit 0)  started just now`,
          '  inputs: {"greeting":"Hello"}',
          "  │ Hello, what is your name?",
          "  answers:",
          "    name: string (required)",
          "    approve: boolean",
          `  aitw inbox answer ${workflowId} --step ask --visit 0 --values '{...}' --detach`,
        ].join("\n"),
      );
    } finally {
      await worker.stop();
      await cancelRun(workflowId);
    }
  }, 60_000);

  it("reports a run that no Worker serves, and how to follow it", async () => {
    const { workflowId } = await detachWaiting();
    try {
      const result = await list();

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`${workflowId}: cannot read what it waits for: `);
      expect(result.stderr).toContain(
        `Run "aitw resume ${workflowId} --address ${environment.address}" to follow it\n`,
      );
    } finally {
      await cancelRun(workflowId);
    }
  }, 60_000);

  it("does not answer a run that the resident process does not run", async () => {
    const { workflowId } = await detachWaiting();
    try {
      await expect(answer(workflowId, '{"name":"aitw"}')).resolves.toEqual({
        exitCode: 1,
        stderr: `wait-valid: aitw daemon does not run ${workflowId}, so it would stop after the answer. Run "aitw resume ${workflowId} --address ${environment.address}" to answer and follow it\n`,
        stdout: "",
      });
    } finally {
      await cancelRun(workflowId);
    }
  }, 60_000);

  it("rejects values that are not a JSON object", async () => {
    await expect(answer("wait-valid-1", "name=aitw")).resolves.toEqual({
      exitCode: 1,
      stderr: "--values must be a JSON object or the path of a .json file: name=aitw\n",
      stdout: "",
    });
  });

  it("reports a run that is not running in the project", async () => {
    await expect(answer("missing-1", "{}")).resolves.toEqual({
      exitCode: 1,
      stderr: "No running run missing-1 in this project\n",
      stdout: "",
    });
  }, 60_000);

  it("needs a project", async () => {
    await expect(list(tmpdir())).resolves.toMatchObject({ exitCode: 1, stdout: "" });
  });
});
