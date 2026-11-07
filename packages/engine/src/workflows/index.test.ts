import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { intermediateVersion } from "@aitw/core";
import type { Intermediate, ScriptRequest, ScriptResult } from "@aitw/core";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createActivities } from "../activities/index.ts";
import { interpreterWorkflow } from "./index.ts";

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

describe("interpreterWorkflow", () => {
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
          run: async (request): Promise<ScriptResult> => {
            requests.push(request);
            return { exitCode: exitCodes[request.run] ?? 0, stderr: "", stdout: "" };
          },
        },
      }),
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(new URL("./index.ts", import.meta.url)),
    });

    const result = await worker.runUntil(
      environment.client.workflow
        .execute(interpreterWorkflow, { args: [input], taskQueue, workflowId: randomUUID() })
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

    expect(result.ok).toBe(false);
    expect(requests.map(({ run: command }) => command)).toEqual(["./fetch.sh"]);
  }, 60_000);

  it("rejects an invalid intermediate representation", async () => {
    const { requests, result } = await run({ ...intermediate, start: "missing" });

    expect(result.ok).toBe(false);
    expect(requests).toEqual([]);
  }, 60_000);
});
