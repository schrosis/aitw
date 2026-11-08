import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { intermediateVersion } from "@aitw/core";
import type { Intermediate, ScriptRequest } from "@aitw/core";
import { WorkflowUpdateFailedError } from "@temporalio/client";
import type { WorkflowHandle } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { createActivities } from "../activities/index.ts";
import { answerUpdateName, waitingQueryName } from "../messages.ts";
import type { Answer, WaitingStep } from "../messages.ts";
import { aitw } from "./index.ts";

const intermediate: Intermediate = {
  inputs: { greeting: { default: "Hello", required: false, type: "string" } },
  start: "ask",
  steps: {
    ask: {
      answers: {
        approve: { required: false, type: "boolean" },
        name: { required: true, type: "string" },
      },
      inputs: { prefix: "${{ workflow.inputs.greeting }}" },
      method: "terminal",
      next: { step: "greet", type: "step" },
      outputs: {
        approve: "${{ result.approve }}",
        label: "${{ inputs.prefix }} ${{ result.name }}",
      },
      type: "wait",
      with: {
        message: "${{ inputs.prefix }}, who are you?",
        tags: ["${{ workflow.inputs.greeting }}"],
      },
    },
    greet: {
      inputs: {},
      next: { type: "end" },
      outputs: {},
      run: 'echo "${{ steps.ask.outputs.label }} ${{ steps.ask.outputs.approve }}"',
      timeoutMs: 5000,
      type: "script",
    },
  },
  version: intermediateVersion,
};

/** Waits until the workflow waits for an answer. */
const waitForStep = async (handle: WorkflowHandle): Promise<WaitingStep> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await handle.query<WaitingStep | null>(waitingQueryName);
    if (waiting !== null) {
      return waiting;
    }
    await sleep(50);
  }
  throw new Error("The workflow did not wait for an answer");
};

const answer = async (handle: WorkflowHandle, value: Answer) =>
  handle.executeUpdate(answerUpdateName, { args: [value] });

describe("aitw wait steps", () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal({
      server: { executable: { path: inject("temporalCli"), type: "existing-path" } },
    });
  }, 120_000);

  afterAll(async () => {
    await environment?.teardown();
  });

  const withWorkflow = async (
    test: (handle: WorkflowHandle, requests: ScriptRequest[]) => Promise<void>,
  ) => {
    const requests: ScriptRequest[] = [];
    const taskQueue = randomUUID();
    const worker = await Worker.create({
      activities: createActivities({
        scriptRunner: {
          run: async (request) => {
            requests.push(request);
            return { exitCode: 0, signal: null, stderr: "", stdout: "" };
          },
        },
      }),
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(new URL("./index.ts", import.meta.url)),
    });
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start(aitw, {
        args: [intermediate],
        taskQueue,
        workflowId: randomUUID(),
      });
      await test(handle, requests);
    });
  };

  it("waits with the evaluated options and continues with the answers", async () => {
    await withWorkflow(async (handle, requests) => {
      await expect(waitForStep(handle)).resolves.toEqual({
        answers: intermediate.steps.ask?.type === "wait" ? intermediate.steps.ask.answers : {},
        method: "terminal",
        options: { message: "Hello, who are you?", tags: ["Hello"] },
        step: "ask",
      });

      await answer(handle, { step: "ask", values: { name: "aitw" } });

      await expect(handle.result()).resolves.toEqual({ executedSteps: ["ask", "greet"] });
      // The optional answer that was not given is null, and embeds as an empty string.
      expect(requests.map(({ run }) => run)).toEqual(['echo "Hello aitw "']);
      await expect(handle.query(waitingQueryName)).resolves.toBeNull();
    });
  }, 60_000);

  it.each([
    [{ step: "ask", values: {} }, "ask.name: Required"],
    [{ step: "ask", values: { name: 1 } }, "ask.name: Must be a string"],
    [{ step: "greet", values: { name: "aitw" } }, "Step greet is not waiting for an answer"],
  ])(
    "rejects the answer %j and keeps waiting",
    async (value, message) => {
      await withWorkflow(async (handle) => {
        await waitForStep(handle);

        const rejected = await answer(handle, value).catch((error: unknown) => error);
        expect(rejected).toBeInstanceOf(WorkflowUpdateFailedError);
        expect(rejected).toMatchObject({ cause: { message } });

        await expect(waitForStep(handle)).resolves.toMatchObject({ step: "ask" });
        await handle.terminate();
      });
    },
    60_000,
  );

  it("stops waiting when the workflow is cancelled", async () => {
    await withWorkflow(async (handle, requests) => {
      await waitForStep(handle);
      await handle.cancel();

      await expect(handle.result()).rejects.toMatchObject({ cause: { name: "CancelledFailure" } });
      expect(requests).toEqual([]);
    });
  }, 60_000);
});
