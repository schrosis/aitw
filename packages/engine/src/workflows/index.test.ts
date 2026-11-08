import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { intermediateVersion } from "@aitw/core";
import type { Intermediate, ScriptRequest, ScriptResult } from "@aitw/core";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { createActivities } from "../activities/index.ts";
import type { ScriptStepRequest } from "../activities/index.ts";
import { aitw } from "./index.ts";

const step = (run: string, next: string | null): Intermediate["steps"][string] => ({
  input: {},
  next: next === null ? { type: "end" } : { step: next, type: "step" },
  output: {},
  run,
  timeoutMs: 5000,
  type: "script",
});

const intermediate: Intermediate = {
  start: "fetch",
  steps: { fetch: step("./fetch.sh", "report"), report: step("./report.sh", null) },
  version: intermediateVersion,
  input: {},
};

describe("aitw", () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal({
      server: { executable: { path: inject("temporalCli"), type: "existing-path" } },
    });
  }, 120_000);

  afterAll(async () => {
    await environment?.teardown();
  });

  const run = async (
    input: unknown,
    exitCodes: Record<string, number> = {},
    stdouts: Record<string, string> = {},
    workflowInput?: unknown,
  ) => {
    const requests: ScriptRequest[] = [];
    const stepRequests: ScriptStepRequest[] = [];
    const taskQueue = randomUUID();
    const activities = createActivities({
      scriptRunner: {
        run: async (request, { signal }): Promise<ScriptResult> => {
          expect(signal).toBeInstanceOf(AbortSignal);
          requests.push(request);
          return {
            exitCode: exitCodes[request.run] ?? 0,
            signal: null,
            stderr: "",
            stdout: stdouts[request.run] ?? "",
          };
        },
      },
    });
    const worker = await Worker.create({
      activities: {
        // Records what the workflow sends, which the history stores.
        executeScriptStep: async (request: ScriptStepRequest) => {
          stepRequests.push(request);
          return activities.executeScriptStep(request);
        },
      },
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(new URL("./index.ts", import.meta.url)),
    });

    const result = await worker.runUntil(
      environment.client.workflow
        .execute(aitw, {
          args: workflowInput === undefined ? [input] : [input, workflowInput],
          taskQueue,
          workflowId: randomUUID(),
        })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ error, ok: false as const }),
        ),
    );
    return { requests, result, stepRequests };
  };

  it("runs the steps in order", async () => {
    const { requests, result } = await run(intermediate);

    expect(result).toEqual({
      ok: true,
      value: { executedSteps: ["fetch", "report"] },
    });
    expect(requests).toEqual([
      { input: {}, run: "./fetch.sh", timeoutMs: 5000 },
      { input: {}, run: "./report.sh", timeoutMs: 5000 },
    ]);
  }, 60_000);

  it("stops when a script fails", async () => {
    const { requests, result } = await run(intermediate, { "./fetch.sh": 1 });

    expect(result).toMatchObject({
      error: { cause: { cause: { type: "ScriptFailed" } } },
      ok: false,
    });
    expect(requests.map(({ run: command }) => command)).toEqual(["./fetch.sh"]);
  }, 60_000);

  it("stops a running script when the workflow is cancelled", async () => {
    const taskQueue = randomUUID();
    let started!: () => void;
    const startedScript = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted!: () => void;
    const abortedScript = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const worker = await Worker.create({
      activities: createActivities({
        heartbeatIntervalMs: 100,
        scriptRunner: {
          run: async (_request, { signal }): Promise<ScriptResult> =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => {
                aborted();
                reject(signal.reason);
              });
              started();
            }),
        },
      }),
      connection: environment.nativeConnection,
      defaultHeartbeatThrottleInterval: "100 milliseconds",
      maxHeartbeatThrottleInterval: "100 milliseconds",
      taskQueue,
      workflowsPath: fileURLToPath(new URL("./index.ts", import.meta.url)),
    });

    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start(aitw, {
        args: [intermediate],
        taskQueue,
        workflowId: randomUUID(),
      });
      await startedScript;
      await handle.cancel();
      // Without heartbeats, the script would be stopped only by the 30 second heartbeat timeout.
      await Promise.race([
        abortedScript,
        sleep(10_000).then(() => {
          throw new Error("The script was not stopped by the cancellation");
        }),
      ]);
    });
  }, 60_000);

  it("passes output values to later steps", async () => {
    const { requests, result } = await run(
      {
        ...intermediate,
        steps: {
          fetch: { ...step("./fetch.sh", "report"), output: { title: "${{ result.stdout }}" } },
          report: {
            ...step('./report.sh "${{ input.title }}"', null),
            input: { title: "${{ steps.fetch.output.title }}" },
          },
        },
      },
      {},
      { "./fetch.sh": "hello\n" },
    );

    expect(result).toEqual({
      ok: true,
      value: { executedSteps: ["fetch", "report"] },
    });
    expect(requests.at(-1)).toEqual({
      input: { title: "hello" },
      run: './report.sh "hello"',
      timeoutMs: 5000,
    });
  }, 60_000);

  it("fails when the combined input exceeds the size limit", async () => {
    const half = "x".repeat(300 * 1024);
    const { requests, result } = await run(
      {
        ...intermediate,
        start: "first",
        steps: {
          first: { ...step("./first.sh", "second"), output: { data: "${{ result.stdout }}" } },
          second: { ...step("./second.sh", "report"), output: { data: "${{ result.stdout }}" } },
          report: {
            ...step("./report.sh", null),
            input: {
              first: "${{ steps.first.output.data }}",
              second: "${{ steps.second.output.data }}",
            },
          },
        },
      },
      {},
      { "./first.sh": half, "./second.sh": half },
    );

    expect(result).toMatchObject({ error: { cause: { type: "InputTooLarge" } }, ok: false });
    expect(requests.map(({ run: command }) => command)).toEqual(["./first.sh", "./second.sh"]);
  }, 60_000);

  it("rejects an unknown input reference before running any step", async () => {
    const { requests, result } = await run({
      ...intermediate,
      steps: {
        fetch: step("./fetch.sh", "report"),
        report: {
          ...step("./report.sh", null),
          input: { title: "${{ steps.fetch.output.title }}" },
        },
      },
    });

    expect(result).toMatchObject({ error: { cause: { type: "InvalidIntermediate" } }, ok: false });
    expect(requests).toEqual([]);
  }, 60_000);

  const withWorkflowInput: Intermediate = {
    ...intermediate,
    input: {
      level: { options: ["low", "high"], required: true, type: "choice" },
      note: { required: false, type: "string" },
      threshold: { default: 1.5, required: false, type: "number" },
    },
    steps: {
      fetch: {
        ...step('./fetch.sh "${{ input.threshold }}" "${{ input.note }}"', null),
        input: {
          level: "${{ workflow.input.level }}",
          note: "${{ workflow.input.note }}",
          threshold: "${{ workflow.input.threshold }}",
        },
      },
    },
  };

  it("passes the workflow input to steps with defaults applied", async () => {
    const { requests, result } = await run(withWorkflowInput, {}, {}, { level: "high" });

    expect(result).toEqual({ ok: true, value: { executedSteps: ["fetch"] } });
    expect(requests).toEqual([
      {
        input: { level: "high", note: null, threshold: 1.5 },
        run: './fetch.sh "1.5" ""',
        timeoutMs: 5000,
      },
    ]);
  }, 60_000);

  it("expands earlier outputs and the workflow input in run directly", async () => {
    const { requests, result } = await run(
      {
        ...intermediate,
        input: { prefix: { default: "pre", required: false, type: "string" } },
        steps: {
          fetch: { ...step("./fetch.sh", "report"), output: { title: "${{ result.stdout }}" } },
          report: step(
            './report.sh "${{ workflow.input.prefix }}" "${{ steps.fetch.output.title }}"',
            null,
          ),
        },
      },
      {},
      { "./fetch.sh": "hello\n" },
      {},
    );

    expect(result).toEqual({ ok: true, value: { executedSteps: ["fetch", "report"] } });
    expect(requests.at(-1)).toEqual({
      input: {},
      run: './report.sh "pre" "hello"',
      timeoutMs: 5000,
    });
  }, 60_000);

  it("sends only the referenced values to a step", async () => {
    const { stepRequests } = await run(
      {
        ...intermediate,
        input: {
          level: { default: "high", required: false, type: "string" },
          unused: { default: "x", required: false, type: "string" },
        },
        steps: {
          fetch: {
            ...step("./fetch.sh", "report"),
            output: { title: "${{ result.stdout }}", unused: "${{ result.stderr }}" },
          },
          report: {
            ...step("./report.sh ${{ steps.fetch.output.title }}", null),
            output: { level: "${{ workflow.input.level }}" },
          },
        },
      },
      {},
      { "./fetch.sh": "hello" },
      {},
    );

    expect(stepRequests.at(-1)?.references).toEqual({
      steps: { fetch: { output: { title: "hello" } } },
      workflow: { input: { level: "high" } },
    });
  }, 60_000);

  it("fails when the referenced values exceed the size limit", async () => {
    const half = "x".repeat(300 * 1024);
    const { requests, result } = await run(
      {
        ...intermediate,
        start: "first",
        steps: {
          first: { ...step("./first.sh", "second"), output: { data: "${{ result.stdout }}" } },
          second: { ...step("./second.sh", "report"), output: { data: "${{ result.stdout }}" } },
          report: step(
            './report.sh "${{ steps.first.output.data }}" "${{ steps.second.output.data }}"',
            null,
          ),
        },
      },
      {},
      { "./first.sh": half, "./second.sh": half },
    );

    expect(result).toMatchObject({ error: { cause: { type: "InputTooLarge" } }, ok: false });
    expect(requests.map(({ run: command }) => command)).toEqual(["./first.sh", "./second.sh"]);
  }, 60_000);

  it("rejects invalid workflow input before running any step", async () => {
    const { requests, result } = await run(withWorkflowInput, {}, {}, { level: "mid" });

    expect(result).toMatchObject({
      error: {
        cause: { message: "workflow.input.level: Must be one of low, high", type: "InvalidInput" },
      },
      ok: false,
    });
    expect(requests).toEqual([]);
  }, 60_000);

  it("rejects missing required workflow input when started without it", async () => {
    const { result } = await run(withWorkflowInput);

    expect(result).toMatchObject({ error: { cause: { type: "InvalidInput" } }, ok: false });
  }, 60_000);

  it("rejects an invalid intermediate representation", async () => {
    const { requests, result } = await run({ ...intermediate, start: "missing" });

    expect(result).toMatchObject({ error: { cause: { type: "InvalidIntermediate" } }, ok: false });
    expect(requests).toEqual([]);
  }, 60_000);
});
