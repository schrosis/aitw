import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { intermediateVersion } from "@aitw/core";
import type { AiRequest, Intermediate, ScriptRequest, ScriptResult } from "@aitw/core";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { createActivities } from "../activities/index.ts";
import type { ScriptStepRequest } from "../activities/index.ts";
import { aitw } from "./index.ts";

const step = (run: string, next: string | null): Intermediate["steps"][string] => ({
  inputs: {},
  next: next === null ? { type: "end" } : { step: next, type: "step" },
  outputs: {},
  run,
  timeoutMs: 5000,
  type: "script",
});

const intermediate: Intermediate = {
  start: "fetch",
  steps: { fetch: step("./fetch.sh", "report"), report: step("./report.sh", null) },
  version: intermediateVersion,
  inputs: {},
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

  it("passes the environment of the workflow and of the step", async () => {
    const { requests, result } = await run(
      {
        ...intermediate,
        dotenv: ".env",
        env: { LEVEL: "${{ workflow.inputs.level }}" },
        inputs: { level: { default: "info", required: false, type: "string" } },
        steps: {
          fetch: { ...step("./fetch.sh", "report"), outputs: { title: "${{ result.stdout }}" } },
          report: {
            ...step("./report.sh", null),
            env: { TITLE: "${{ steps.fetch.outputs.title }}" },
          },
        },
      },
      {},
      { "./fetch.sh": "hello\n" },
    );

    expect(result).toMatchObject({ ok: true });
    expect(requests.map(({ dotenv, env }) => ({ dotenv, env }))).toEqual([
      { dotenv: ".env", env: { LEVEL: "info" } },
      { dotenv: ".env", env: { LEVEL: "info", TITLE: "hello" } },
    ]);
  }, 60_000);

  it("runs an AI step and passes its result to later steps", async () => {
    const aiRequests: AiRequest[] = [];
    const scriptRequests: ScriptRequest[] = [];
    const taskQueue = randomUUID();
    const worker = await Worker.create({
      activities: createActivities({
        aiRunner: {
          run: async (request) => {
            aiRequests.push(request);
            return { data: { verdict: "approve" }, sessionId: "s1" };
          },
        },
        scriptRunner: {
          run: async (request) => {
            scriptRequests.push(request);
            return { exitCode: 0, signal: null, stderr: "", stdout: "" };
          },
        },
      }),
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(new URL("./index.ts", import.meta.url)),
    });
    const input: Intermediate = {
      ...intermediate,
      env: { LEVEL: "${{ workflow.inputs.level }}" },
      inputs: { level: { default: "info", required: false, type: "string" } },
      start: "review",
      steps: {
        report: { ...step("echo ${{ steps.review.outputs.verdict }}", null) },
        review: {
          inputs: {},
          model: "claude-opus-5-5",
          next: { step: "report", type: "step" },
          outputs: { verdict: "${{ result.data.verdict }}" },
          prompt: "Review for ${{ workflow.inputs.level }}",
          provider: "claude-code",
          schema: { type: "object" },
          session: "reuse",
          timeoutMs: 5000,
          type: "ai",
          with: { note: "${{ workflow.inputs.level }}" },
        },
      },
    };

    await worker.runUntil(
      environment.client.workflow.execute(aitw, {
        args: [input],
        taskQueue,
        workflowId: randomUUID(),
      }),
    );

    expect(aiRequests).toEqual([
      {
        env: { LEVEL: "info" },
        model: "claude-opus-5-5",
        options: { note: "info" },
        prompt: "Review for info",
        provider: "claude-code",
        schema: { type: "object" },
        timeoutMs: 5000,
      },
    ]);
    expect(scriptRequests.map(({ run: command }) => command)).toEqual(["echo approve"]);
  }, 60_000);

  it("runs the steps in order", async () => {
    const { requests, result } = await run(intermediate);

    expect(result).toEqual({
      ok: true,
      value: { executedSteps: ["fetch", "report"] },
    });
    expect(requests).toEqual([
      { inputs: {}, run: "./fetch.sh", timeoutMs: 5000 },
      { inputs: {}, run: "./report.sh", timeoutMs: 5000 },
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
          fetch: { ...step("./fetch.sh", "report"), outputs: { title: "${{ result.stdout }}" } },
          report: {
            ...step('./report.sh "${{ inputs.title }}"', null),
            inputs: { title: "${{ steps.fetch.outputs.title }}" },
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
      inputs: { title: "hello" },
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
          first: { ...step("./first.sh", "second"), outputs: { data: "${{ result.stdout }}" } },
          second: { ...step("./second.sh", "report"), outputs: { data: "${{ result.stdout }}" } },
          report: {
            ...step("./report.sh", null),
            inputs: {
              first: "${{ steps.first.outputs.data }}",
              second: "${{ steps.second.outputs.data }}",
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
          inputs: { title: "${{ steps.fetch.outputs.title }}" },
        },
      },
    });

    expect(result).toMatchObject({ error: { cause: { type: "InvalidIntermediate" } }, ok: false });
    expect(requests).toEqual([]);
  }, 60_000);

  const withWorkflowInput: Intermediate = {
    ...intermediate,
    inputs: {
      level: { options: ["low", "high"], required: true, type: "choice" },
      note: { required: false, type: "string" },
      threshold: { default: 1.5, required: false, type: "number" },
    },
    steps: {
      fetch: {
        ...step('./fetch.sh "${{ inputs.threshold }}" "${{ inputs.note }}"', null),
        inputs: {
          level: "${{ workflow.inputs.level }}",
          note: "${{ workflow.inputs.note }}",
          threshold: "${{ workflow.inputs.threshold }}",
        },
      },
    },
  };

  it("passes the workflow input to steps with defaults applied", async () => {
    const { requests, result } = await run(withWorkflowInput, {}, {}, { level: "high" });

    expect(result).toEqual({ ok: true, value: { executedSteps: ["fetch"] } });
    expect(requests).toEqual([
      {
        inputs: { level: "high", note: null, threshold: 1.5 },
        run: './fetch.sh "1.5" ""',
        timeoutMs: 5000,
      },
    ]);
  }, 60_000);

  it("expands earlier outputs and the workflow input in run directly", async () => {
    const { requests, result } = await run(
      {
        ...intermediate,
        inputs: { prefix: { default: "pre", required: false, type: "string" } },
        steps: {
          fetch: { ...step("./fetch.sh", "report"), outputs: { title: "${{ result.stdout }}" } },
          report: step(
            './report.sh "${{ workflow.inputs.prefix }}" "${{ steps.fetch.outputs.title }}"',
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
      inputs: {},
      run: './report.sh "pre" "hello"',
      timeoutMs: 5000,
    });
  }, 60_000);

  it("sends only the referenced values to a step", async () => {
    const { stepRequests } = await run(
      {
        ...intermediate,
        inputs: {
          level: { default: "high", required: false, type: "string" },
          unused: { default: "x", required: false, type: "string" },
        },
        steps: {
          fetch: {
            ...step("./fetch.sh", "report"),
            outputs: { title: "${{ result.stdout }}", unused: "${{ result.stderr }}" },
          },
          report: {
            ...step("./report.sh ${{ steps.fetch.outputs.title }}", null),
            outputs: { level: "${{ workflow.inputs.level }}" },
          },
        },
      },
      {},
      { "./fetch.sh": "hello" },
      {},
    );

    expect(stepRequests.at(-1)?.references).toEqual({
      steps: { fetch: { outputs: { title: "hello" } } },
      workflow: { inputs: { level: "high" } },
    });
  }, 60_000);

  it("fails when the referenced values exceed the size limit", async () => {
    const half = "x".repeat(300 * 1024);
    const { requests, result } = await run(
      {
        ...intermediate,
        start: "first",
        steps: {
          first: { ...step("./first.sh", "second"), outputs: { data: "${{ result.stdout }}" } },
          second: { ...step("./second.sh", "report"), outputs: { data: "${{ result.stdout }}" } },
          report: step(
            './report.sh "${{ steps.first.outputs.data }}" "${{ steps.second.outputs.data }}"',
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
        cause: { message: "workflow.inputs.level: Must be one of low, high", type: "InvalidInput" },
      },
      ok: false,
    });
    expect(requests).toEqual([]);
  }, 60_000);

  it("rejects missing required workflow input when started without it", async () => {
    const { result } = await run(withWorkflowInput);

    expect(result).toMatchObject({ error: { cause: { type: "InvalidInput" } }, ok: false });
  }, 60_000);

  it("rejects a wait step whose method describes no answers", async () => {
    const { requests, result } = await run({
      ...intermediate,
      steps: {
        ...intermediate.steps,
        fetch: {
          inputs: {},
          method: "terminal",
          next: { step: "report", type: "step" },
          outputs: {},
          type: "wait",
          with: { message: "Continue?" },
        },
      },
    });

    expect(result).toMatchObject({ error: { cause: { type: "UnsupportedStep" } }, ok: false });
    expect(requests).toEqual([]);
  }, 60_000);

  it("rejects an invalid intermediate representation", async () => {
    const { requests, result } = await run({ ...intermediate, start: "missing" });

    expect(result).toMatchObject({ error: { cause: { type: "InvalidIntermediate" } }, ok: false });
    expect(requests).toEqual([]);
  }, 60_000);
});
