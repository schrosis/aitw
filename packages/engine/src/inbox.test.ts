import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createPluginRegistry, definePlugin, intermediateVersion } from "@aitw/core";
import type { Intermediate } from "@aitw/core";
import type { WorkflowHandle } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { z } from "zod";

import { createActivities } from "./activities/index.ts";
import { AnswerRejectedError, answerInbox, listInbox } from "./inbox.ts";
import { waitingQueryName } from "./messages.ts";
import { aitw } from "./workflows/index.ts";

/** A workflow that waits at `ask`, whose method answers where `respondIn` says. */
const waiting = (respondIn?: "worker"): Intermediate => ({
  inputs: { target: { required: true, type: "string" } },
  start: "ask",
  steps: {
    ask: {
      answers: { ok: { required: true, type: "boolean" } },
      inputs: {},
      method: respondIn === undefined ? "terminal" : "watch",
      next: { type: "end" },
      outputs: {},
      ...(respondIn === undefined ? {} : { respondIn }),
      type: "wait",
      with: { message: "Deploy ${{ workflow.inputs.target }}?" },
    },
  },
  version: intermediateVersion,
});

const waitForStep = async (handle: WorkflowHandle): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await handle.query(waitingQueryName)) !== null) {
      return;
    }
    await sleep(50);
  }
  throw new Error("The workflow did not wait");
};

describe("inbox", () => {
  let environment: TestWorkflowEnvironment;
  const taskQueue = randomUUID();
  // Each test marks its runs, so that it lists only them.
  const memoKey = "test.case";

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal({
      server: { executable: { path: inject("temporalCli"), type: "existing-path" } },
    });
  }, 120_000);

  afterAll(async () => {
    await environment?.teardown();
  });

  const withWorker = async (test: () => Promise<void>): Promise<void> => {
    const worker = await Worker.create({
      activities: createActivities({
        // A method that answers in the Worker, and keeps waiting until the run ends.
        plugins: createPluginRegistry({
          builtins: [
            definePlugin({
              name: "test",
              waitMethods: [
                {
                  name: "watch",
                  respond: async ({ signal }) =>
                    new Promise((_resolve, reject) => {
                      signal.addEventListener("abort", () => reject(new Error("stopped")));
                    }),
                  respondIn: "worker",
                  with: z.strictObject({ message: z.string() }),
                },
              ],
            }),
          ],
        }),
        scriptRunner: { run: async () => ({ exitCode: 0, signal: null, stderr: "", stdout: "" }) },
      }),
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(new URL("./workflows/index.ts", import.meta.url)),
    });
    await worker.runUntil(test);
  };

  const start = async (
    testCase: string,
    intermediate: Intermediate,
    queue = taskQueue,
  ): Promise<WorkflowHandle> =>
    environment.client.workflow.start(aitw, {
      args: [intermediate, { target: testCase }],
      memo: { [memoKey]: testCase },
      taskQueue: queue,
      workflowId: `${testCase}-${randomUUID()}`,
    });

  it("lists the steps that wait for someone, but not those that a Worker answers", async () => {
    await withWorker(async () => {
      const asked = await start("list", waiting());
      const watched = await start("list", waiting("worker"));
      await waitForStep(asked);
      await waitForStep(watched);

      const inbox = await listInbox({ address: environment.address, memo: { [memoKey]: "list" } });

      expect(inbox).toEqual({
        questions: [
          {
            answers: { ok: { required: true, type: "boolean" } },
            method: "terminal",
            options: { message: "Deploy list?" },
            run: expect.objectContaining({ workflowId: asked.workflowId }) as unknown,
            step: "ask",
            visit: 0,
            workflowInputs: { target: "list" },
          },
        ],
        unreadable: [],
      });
      await asked.terminate();
      await watched.terminate();
    });
  }, 60_000);

  it("reports a run that no Worker serves", async () => {
    const handle = await start("unread", waiting(), randomUUID());

    const inbox = await listInbox({ address: environment.address, memo: { [memoKey]: "unread" } });

    expect(inbox.questions).toEqual([]);
    expect(inbox.unreadable).toEqual([
      {
        reason: expect.any(String) as unknown,
        run: expect.objectContaining({ workflowId: handle.workflowId }) as unknown,
      },
    ]);
    await handle.terminate();
  }, 60_000);

  it("answers a step, and rejects an answer that the run does not take", async () => {
    await withWorker(async () => {
      const handle = await start("answer", waiting());
      await waitForStep(handle);
      const answer = async (values: Record<string, unknown>, visit?: number) =>
        answerInbox({
          address: environment.address,
          step: "ask",
          values,
          visit,
          workflowId: handle.workflowId,
        });

      await expect(answer({ ok: "yes" })).rejects.toThrow(
        new AnswerRejectedError("ask.ok: Must be a boolean"),
      );
      await expect(answer({ ok: true }, 1)).rejects.toThrow(
        new AnswerRejectedError("Step ask is not waiting for an answer"),
      );
      await answer({ ok: true }, 0);

      await expect(handle.result()).resolves.toEqual({ executedSteps: ["ask"] });
    });
  }, 60_000);
});
