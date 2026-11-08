import { fileURLToPath } from "node:url";

import { createPluginRegistry, definePlugin, intermediateVersion } from "@aitw/core";
import type { Intermediate, ScriptRequest, WaitMethod, WorkflowEvent } from "@aitw/core";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { z } from "zod";

import { runWorkflow } from "./run.ts";

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

const pluginsWith = (respond: WaitMethod["respond"]) =>
  createPluginRegistry({
    builtins: [
      definePlugin({
        name: "test",
        waitMethods: [
          {
            name: "ask",
            ...(respond === undefined ? {} : { respond }),
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

    await expect(result).resolves.toEqual({ executedSteps: ["fetch"] });
    expect(requests.map(({ run: command }) => command)).toEqual(["./fetch.sh"]);
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
      ).resolves.toEqual({ executedSteps: ["ask", "fetch"] });

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
        { step: "ask", type: "stepStarted" },
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
      expect(events.at(-1)).toMatchObject({
        message: "no one is here",
        outcome: "failed",
        step: "ask",
      });
    }, 60_000);

    it("fails a run whose wait method cannot answer here", async () => {
      await expect(runWaiting(undefined)).rejects.toThrow(
        "steps.ask: Wait method ask cannot answer in this process",
      );
    }, 60_000);
  });
});
