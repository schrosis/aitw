import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { intermediateVersion } from "@aitw/core";
import type { Intermediate, ScriptRequest, ScriptResult } from "@aitw/core";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createActivities } from "../activities/index.ts";
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
};

describe("aitw", () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal();
  }, 120_000);

  afterAll(async () => {
    await environment?.teardown();
  });

  const run = async (input: unknown, exitCodes: Record<string, number> = {}) => {
    const requests: ScriptRequest[] = [];
    const taskQueue = randomUUID();
    const worker = await Worker.create({
      activities: createActivities({
        scriptRunner: {
          run: async (request, { signal }): Promise<ScriptResult> => {
            expect(signal).toBeInstanceOf(AbortSignal);
            requests.push(request);
            return { exitCode: exitCodes[request.run] ?? 0, signal: null, stderr: "", stdout: "" };
          },
        },
      }),
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(new URL("./index.ts", import.meta.url)),
    });

    const result = await worker.runUntil(
      environment.client.workflow
        .execute(aitw, { args: [input], taskQueue, workflowId: randomUUID() })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ error, ok: false as const }),
        ),
    );
    return { requests, result };
  };

  it("runs the steps in order", async () => {
    const { requests, result } = await run(intermediate);

    expect(result).toEqual({ ok: true, value: { executedSteps: ["fetch", "report"] } });
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

  it("rejects an invalid intermediate representation", async () => {
    const { requests, result } = await run({ ...intermediate, start: "missing" });

    expect(result).toMatchObject({ error: { cause: { type: "InvalidIntermediate" } }, ok: false });
    expect(requests).toEqual([]);
  }, 60_000);
});
