import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createPluginRegistry, definePlugin, intermediateVersion } from "@aitw/core";
import type {
  Intermediate,
  ScriptRequest,
  ScriptStep,
  WaitMethod,
  WorkflowEvent,
} from "@aitw/core";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { z } from "zod";

import { answeredElsewhereMessage } from "./answer.ts";
import { createMemoryEventLog } from "./events.ts";
import { answerInbox } from "./inbox.ts";
import { listRunningWorkflows, resumeWorkflow, runWorkflow, startWorkflow } from "./run.ts";
import { startWorker } from "./worker.ts";
import {
  IncompatibleRunError,
  workflowCodeVersion,
  workflowCodeVersionMemoKey,
} from "./version.ts";
import type { RunOutcome } from "./run.ts";

const intermediate: Intermediate = {
  start: "fetch",
  steps: {
    fetch: {
      inputs: {},
      next: { type: "end" },
      outputs: {},
      run: "./fetch.sh",
      timeoutMs: 5000,
      type: "script",
    },
  },
  version: intermediateVersion,
  inputs: {},
};

const pluginsWith = (
  respond: WaitMethod["respond"],
  respondIn: WaitMethod["respondIn"] = "follower",
) =>
  createPluginRegistry({
    builtins: [
      definePlugin({
        name: "test",
        waitMethods: [
          {
            name: "ask",
            ...(respond === undefined ? {} : { respond }),
            respondIn,
            with: z.strictObject({ message: z.string() }),
          },
        ],
      }),
    ],
  });

describe("runWorkflow", () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal({
      server: { executable: { path: inject("temporalCli"), type: "existing-path" } },
    });
  }, 120_000);

  afterAll(async () => {
    await environment?.teardown();
  });

  const run = async (exitCode: number) => {
    const requests: ScriptRequest[] = [];
    const result = runWorkflow({
      address: environment.address,
      intermediate,
      name: "release/notes",
      scriptRunner: {
        run: async (request) => {
          requests.push(request);
          return { exitCode, signal: null, stderr: "", stdout: "" };
        },
      },
      workflowsPath: fileURLToPath(new URL("./workflows/index.ts", import.meta.url)),
    });
    return { requests, result };
  };

  it("runs a workflow until it completes", async () => {
    const { requests, result } = await run(0);

    await expect(result).resolves.toEqual({
      executedSteps: ["fetch"],
      status: "completed",
      workflowId: expect.stringMatching(/^release\/notes-[0-9a-f-]{36}$/u) as unknown,
    });
    expect(requests.map(({ run: command }) => command)).toEqual(["./fetch.sh"]);
  }, 60_000);

  it("starts a run for the Worker of another process, without following it", async () => {
    const taskQueue = randomUUID();
    const workflowId = await startWorkflow({
      address: environment.address,
      inputs: {},
      intermediate,
      memo: { "test.project": "detached" },
      name: "release/notes",
      taskQueue,
    });

    expect(workflowId).toMatch(/^release\/notes-[0-9a-f-]{36}$/u);
    await expect(
      listRunningWorkflows({ address: environment.address, memo: { "test.project": "detached" } }),
    ).resolves.toEqual([
      {
        memo: {
          "test.project": "detached",
          [workflowCodeVersionMemoKey]: String(workflowCodeVersion),
        },
        startTime: expect.any(Date) as unknown,
        taskQueue,
        workflowId,
      },
    ]);
    // A Worker that serves the task queue, as the resident process does, runs the steps.
    const worker = await startWorker({
      address: environment.address,
      eventLog: createMemoryEventLog(),
      scriptRunner: { run: async () => ({ exitCode: 0, signal: null, stderr: "", stdout: "" }) },
      taskQueue,
      workflowsPath: fileURLToPath(new URL("./workflows/index.ts", import.meta.url)),
    });
    try {
      await expect(environment.client.workflow.getHandle(workflowId).result()).resolves.toEqual({
        executedSteps: ["fetch"],
      });
    } finally {
      await worker.stop();
    }
  }, 60_000);

  it("passes the workflow input", async () => {
    const requests: ScriptRequest[] = [];
    await runWorkflow({
      address: environment.address,
      inputs: { title: "hello" },
      intermediate: {
        ...intermediate,
        inputs: { title: { required: true, type: "string" } },
        steps: {
          fetch: {
            inputs: { title: "${{ workflow.inputs.title }}" },
            next: { type: "end" },
            outputs: {},
            run: "./fetch.sh ${{ inputs.title }}",
            timeoutMs: 5000,
            type: "script",
          },
        },
      },
      name: "release/notes",
      scriptRunner: {
        run: async (request) => {
          requests.push(request);
          return { exitCode: 0, signal: null, stderr: "", stdout: "" };
        },
      },
      workflowsPath: fileURLToPath(new URL("./workflows/index.ts", import.meta.url)),
    });

    expect(requests.map(({ run: command }) => command)).toEqual(["./fetch.sh hello"]);
  }, 60_000);

  it("cancels the workflow and its script when aborted", async () => {
    const controller = new AbortController();
    let scriptAborted = false;
    const result = runWorkflow({
      address: environment.address,
      intermediate,
      name: "release/notes",
      scriptRunner: {
        run: async (_request, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              scriptAborted = true;
              reject(signal.reason);
            });
            controller.abort();
          }),
      },
      signal: controller.signal,
      workflowsPath: fileURLToPath(new URL("./workflows/index.ts", import.meta.url)),
    });

    await expect(result).rejects.toMatchObject({ cause: { name: "CancelledFailure" } });
    expect(scriptAborted).toBe(true);
  }, 60_000);

  it("warns once when the progress log cannot be read", async () => {
    const warnings: string[] = [];
    await runWorkflow({
      address: environment.address,
      eventLog: {
        append: () => {},
        read: async () => Promise.reject(new Error("permission denied")),
      },
      intermediate,
      name: "release/notes",
      onWarning: (message) => warnings.push(message),
      scriptRunner: { run: async () => ({ exitCode: 0, signal: null, stderr: "", stdout: "" }) },
      workflowsPath: fileURLToPath(new URL("./workflows/index.ts", import.meta.url)),
    });

    expect(warnings).toEqual(["Failed to show the progress of the run: permission denied"]);
  }, 60_000);

  it("throws when the workflow fails", async () => {
    const { result } = await run(1);

    await expect(result).rejects.toMatchObject({ cause: { cause: { type: "ScriptFailed" } } });
  }, 60_000);

  describe("with a wait step", () => {
    const waiting: Intermediate = {
      ...intermediate,
      start: "ask",
      steps: {
        ...intermediate.steps,
        ask: {
          answers: { name: { required: true, type: "string" } },
          inputs: {},
          method: "ask",
          next: { step: "fetch", type: "step" },
          outputs: { name: "${{ result.name }}" },
          type: "wait",
          with: { message: "Name?" },
        },
      },
    };

    const runWaiting = async (respond: WaitMethod["respond"], events: WorkflowEvent[] = []) =>
      runWorkflow({
        address: environment.address,
        eventSink: { emit: (event) => events.push(event) },
        intermediate: waiting,
        name: "ask",
        plugins: pluginsWith(respond),
        scriptRunner: { run: async () => ({ exitCode: 0, signal: null, stderr: "", stdout: "" }) },
        workflowsPath: fileURLToPath(new URL("./workflows/index.ts", import.meta.url)),
      });

    it("answers with the method and asks again when the answer is rejected", async () => {
      const contexts: unknown[] = [];
      const answers = [{}, { name: "aitw" }];
      const events: WorkflowEvent[] = [];

      await expect(
        runWaiting(async (context) => {
          contexts.push({ answers: context.answers, options: context.options, step: context.step });
          return answers.shift() ?? {};
        }, events),
      ).resolves.toMatchObject({ executedSteps: ["ask", "fetch"], status: "completed" });

      expect(contexts).toEqual([
        {
          answers: { name: { required: true, type: "string" } },
          options: { message: "Name?" },
          step: "ask",
        },
        {
          answers: { name: { required: true, type: "string" } },
          options: { message: "Name?" },
          step: "ask",
        },
      ]);
      expect(events.filter(({ step }) => step === "ask")).toEqual([
        { message: "Name?", step: "ask", type: "stepStarted" },
        { step: "ask", stream: "stderr", text: "ask.name: Required\n", type: "stepOutput" },
        {
          durationMs: expect.any(Number) as unknown,
          outcome: "succeeded",
          step: "ask",
          type: "stepFinished",
        },
      ]);
    }, 60_000);

    it("cancels the run and reports why the method could not answer", async () => {
      const events: WorkflowEvent[] = [];

      await expect(
        runWaiting(async () => {
          throw new Error("no one is here");
        }, events),
      ).rejects.toThrow("no one is here");
      // The workflow stores the end of the step, which the cancellation interrupted.
      expect(events.at(-1)).toMatchObject({ outcome: "cancelled", step: "ask" });
    }, 60_000);

    it("lets its Worker answer a step whose method answers in the Worker", async () => {
      const steps: string[] = [];
      const ask = waiting.steps.ask;
      if (ask?.type !== "wait") {
        throw new Error("The test setup is invalid");
      }

      await expect(
        runWorkflow({
          address: environment.address,
          intermediate: {
            ...waiting,
            steps: { ...waiting.steps, ask: { ...ask, respondIn: "worker" } },
          },
          name: "ask",
          plugins: pluginsWith(async ({ step }) => {
            steps.push(step);
            return { name: "aitw" };
          }, "worker"),
          scriptRunner: {
            run: async () => ({ exitCode: 0, signal: null, stderr: "", stdout: "" }),
          },
          workflowsPath: fileURLToPath(new URL("./workflows/index.ts", import.meta.url)),
        }),
      ).resolves.toMatchObject({ executedSteps: ["ask", "fetch"], status: "completed" });
      // The process that follows the run does not ask too.
      expect(steps).toEqual(["ask"]);
    }, 60_000);

    it("stops asking when another process answers, and shows why before the end", async () => {
      const events: WorkflowEvent[] = [];
      const { promise: started, resolve: start } = Promise.withResolvers<string>();
      const { promise: asked, resolve: ask } = Promise.withResolvers<void>();
      let stopped: unknown;

      const running = runWorkflow({
        address: environment.address,
        eventSink: { emit: (event) => events.push(event) },
        intermediate: waiting,
        name: "ask",
        onStart: start,
        plugins: pluginsWith(
          async ({ signal }) =>
            new Promise((_resolve, reject) => {
              ask();
              signal.addEventListener("abort", () => {
                stopped = signal.reason;
                reject(new Error("stopped"));
              });
            }),
        ),
        scriptRunner: { run: async () => ({ exitCode: 0, signal: null, stderr: "", stdout: "" }) },
        workflowsPath: fileURLToPath(new URL("./workflows/index.ts", import.meta.url)),
      });
      const workflowId = await started;
      // The method asks before another process answers.
      await asked;
      await answerInbox({
        address: environment.address,
        step: "ask",
        values: { name: "elsewhere" },
        visit: 0,
        workflowId,
      });

      await expect(running).resolves.toMatchObject({ executedSteps: ["ask", "fetch"] });
      expect(stopped).toBeDefined();
      expect(events.filter(({ step }) => step === "ask").map(({ type }) => type)).toEqual([
        "stepStarted",
        "stepOutput",
        "stepFinished",
      ]);
      expect(events).toContainEqual({
        step: "ask",
        stream: "stderr",
        text: `${answeredElsewhereMessage}\n`,
        type: "stepOutput",
      });
    }, 60_000);

    it("fails a run whose wait method cannot answer here", async () => {
      await expect(runWaiting(undefined)).rejects.toThrow(
        "steps.ask: Wait method ask cannot answer in this process",
      );
    }, 60_000);
  });

  describe("detaching and resuming", () => {
    const waiting: Intermediate = {
      ...intermediate,
      start: "ask",
      steps: {
        ...intermediate.steps,
        ask: {
          answers: { name: { required: true, type: "string" } },
          inputs: {},
          method: "ask",
          next: { step: "fetch", type: "step" },
          outputs: {},
          type: "wait",
          with: { message: "Name?" },
        },
      },
    };
    const workflows = fileURLToPath(new URL("./workflows/index.ts", import.meta.url));
    const succeed = { run: async () => ({ exitCode: 0, signal: null, stderr: "", stdout: "" }) };
    const scriptStep: ScriptStep = {
      inputs: {},
      next: { type: "end" },
      outputs: {},
      run: "./fetch.sh",
      timeoutMs: 5000,
      type: "script",
    };

    it("leaves a waiting run, then resumes it with the earlier events", async () => {
      const eventLog = createMemoryEventLog();
      const detach = new AbortController();
      const first = await runWorkflow({
        address: environment.address,
        eventLog,
        intermediate: waiting,
        memo: { project: "detach-test" },
        name: "ask",
        plugins: pluginsWith(async () => {
          detach.abort();
          return new Promise(() => {});
        }),
        scriptRunner: succeed,
        detach: detach.signal,
        workflowsPath: workflows,
      });
      expect(first).toEqual({ status: "detached", workflowId: expect.any(String) as unknown });

      await expect(
        listRunningWorkflows({ address: environment.address, memo: { project: "detach-test" } }),
      ).resolves.toEqual([
        {
          // The run also records the workflow code version that started it.
          memo: {
            [workflowCodeVersionMemoKey]: String(workflowCodeVersion),
            project: "detach-test",
          },
          startTime: expect.any(Date) as unknown,
          taskQueue: expect.stringMatching(/^aitw-/u) as unknown,
          workflowId: first.workflowId,
        },
      ]);

      const events: WorkflowEvent[] = [];
      const resumed = await resumeWorkflow({
        address: environment.address,
        eventLog,
        eventSink: { emit: (event) => events.push(event) },
        plugins: pluginsWith(async () => ({ name: "aitw" })),
        scriptRunner: succeed,
        workflowId: first.workflowId,
        workflowsPath: workflows,
      });

      expect(resumed).toEqual({
        executedSteps: ["ask", "fetch"],
        status: "completed",
        workflowId: first.workflowId,
      });
      // The resumed run shows the events from the start, including those before it detached.
      expect(events.map(({ step, type }) => `${type} ${step}`)).toEqual([
        "stepStarted ask",
        "stepFinished ask",
        "stepStarted fetch",
        "stepFinished fetch",
      ]);
    }, 60_000);

    it("waits for a running script before it detaches", async () => {
      const detach = new AbortController();
      const outcome = runWorkflow({
        address: environment.address,
        detach: detach.signal,
        intermediate: {
          ...intermediate,
          steps: {
            fetch: { ...scriptStep, next: { step: "report", type: "step" } },
            report: scriptStep,
          },
        },
        name: "slow",
        scriptRunner: {
          run: async (request) => {
            if (request.run === "./fetch.sh" && !detach.signal.aborted) {
              detach.abort();
              // The script keeps running for a while after the run detaches.
              await sleep(500);
            }
            return { exitCode: 0, signal: null, stderr: "", stdout: "" };
          },
        },
        workflowsPath: workflows,
      });

      const result = await outcome;
      // The script finished, and the run waits for a Worker to run the next step.
      expect(result.status).toBe("detached");
      const resumed = await resumeWorkflow({
        address: environment.address,
        scriptRunner: succeed,
        workflowId: result.workflowId,
        workflowsPath: workflows,
      });
      expect(resumed).toMatchObject({ executedSteps: ["fetch", "report"], status: "completed" });
    }, 60_000);

    it("reports a script that failed while the run detached when it is resumed", async () => {
      const detach = new AbortController();
      let detached: RunOutcome;
      try {
        detached = await runWorkflow({
          address: environment.address,
          detach: detach.signal,
          intermediate,
          name: "failing",
          scriptRunner: {
            run: async () => {
              detach.abort();
              await sleep(200);
              return { exitCode: 2, signal: null, stderr: "", stdout: "" };
            },
          },
          workflowsPath: workflows,
        });
      } catch (error) {
        // The workflow learned of the failure before the Worker stopped.
        expect(error).toMatchObject({ cause: { cause: { type: "ScriptFailed" } } });
        return;
      }

      // The Worker stopped before the workflow learned of the failure, so the run waits to be
      // resumed, and it fails then.
      expect(detached).toMatchObject({ status: "detached" });
      await expect(
        resumeWorkflow({
          address: environment.address,
          scriptRunner: succeed,
          workflowId: detached.workflowId,
          workflowsPath: workflows,
        }),
      ).rejects.toMatchObject({ cause: { cause: { type: "ScriptFailed" } } });
    }, 60_000);

    it("does not resume a run of another workflow code version without force", async () => {
      const handle = await environment.client.workflow.start("aitw", {
        args: [waiting, {}],
        memo: { [workflowCodeVersionMemoKey]: "0" },
        taskQueue: `aitw-${randomUUID()}`,
        workflowId: `old-${randomUUID()}`,
      });
      const options = {
        address: environment.address,
        scriptRunner: succeed,
        workflowId: handle.workflowId,
        workflowsPath: workflows,
      };

      await expect(resumeWorkflow(options)).rejects.toThrow(IncompatibleRunError);
      await expect(resumeWorkflow(options)).rejects.toThrow(
        `was started by workflow code version 0, and this aitw has version ${workflowCodeVersion}`,
      );
      await expect(resumeWorkflow({ ...options, cancel: true, force: true })).rejects.toMatchObject(
        {
          cause: { name: "CancelledFailure" },
        },
      );
    }, 60_000);

    it("cancels a run that it resumes", async () => {
      const detach = new AbortController();
      const first = await runWorkflow({
        address: environment.address,
        detach: detach.signal,
        intermediate: waiting,
        name: "ask",
        plugins: pluginsWith(async () => {
          detach.abort();
          return new Promise(() => {});
        }),
        scriptRunner: succeed,
        workflowsPath: workflows,
      });

      await expect(
        resumeWorkflow({
          address: environment.address,
          cancel: true,
          scriptRunner: succeed,
          workflowId: first.workflowId,
          workflowsPath: workflows,
        }),
      ).rejects.toMatchObject({ cause: { name: "CancelledFailure" } });
      await expect(
        resumeWorkflow({
          address: environment.address,
          scriptRunner: succeed,
          workflowId: first.workflowId,
          workflowsPath: workflows,
        }),
      ).rejects.toThrow("is not running: cancelled");
    }, 60_000);
  });
});
