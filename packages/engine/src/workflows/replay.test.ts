import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { intermediateVersion } from "@aitw/core";
import type { Intermediate } from "@aitw/core";
import type { WorkflowHandle } from "@temporalio/client";
import { historyToJSON } from "@temporalio/common/lib/proto-utils";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { describe, expect, inject, it } from "vitest";

import { createActivities } from "../activities/index.ts";
import { createMemoryEventLog } from "../events.ts";
import { answerUpdateName, waitingQueryName } from "../messages.ts";
import { workflowCodeVersion } from "../version.ts";
import { aitw } from "./index.ts";

/**
 * Replay tests: the histories of earlier runs must replay with the current workflow code.
 *
 * A change that fails these tests would break runs that wait in Temporal. Make the change
 * replay, such as with `patched()`, or raise `workflowCodeVersion` and record the histories
 * again with `AITW_RECORD_HISTORIES=1 pnpm --filter @aitw/engine test`.
 */
const historiesDirectory = fileURLToPath(new URL("../../test/histories/", import.meta.url));
const workflowsPath = fileURLToPath(new URL("./index.ts", import.meta.url));

const script = (run: string, next: string | null, fields: object = {}) => ({
  inputs: {},
  next: next === null ? { type: "end" as const } : { step: next, type: "step" as const },
  outputs: {},
  run,
  timeoutMs: 5000,
  type: "script" as const,
  ...fields,
});

/** Runs that cover the paths of the workflow code. */
const scenarios: Record<
  string,
  { intermediate: Intermediate; inputs: object; drive?: (handle: WorkflowHandle) => Promise<void> }
> = {
  scripts: {
    inputs: { prefix: "pre" },
    intermediate: {
      inputs: { prefix: { required: true, type: "string" } },
      start: "fetch",
      steps: {
        fetch: script("echo hello", "report", { outputs: { title: "${{ result.stdout }}" } }),
        report: script(
          'echo "${{ workflow.inputs.prefix }} ${{ steps.fetch.outputs.title }}"',
          null,
        ),
      },
      version: intermediateVersion,
    },
  },
  wait: {
    drive: async (handle) => {
      await waitForStep(handle);
      await handle.executeUpdate(answerUpdateName, {
        args: [{ step: "ask", values: { name: "aitw" } }],
      });
    },
    inputs: {},
    intermediate: {
      inputs: {},
      start: "ask",
      steps: {
        ask: {
          answers: { name: { required: true, type: "string" } },
          inputs: {},
          method: "terminal",
          next: { step: "greet", type: "step" },
          outputs: { name: "${{ result.name }}" },
          type: "wait",
          with: { message: "Name?" },
        },
        greet: script('echo "${{ steps.ask.outputs.name }}"', null),
      },
      version: intermediateVersion,
    },
  },
  "wait-cancelled": {
    drive: async (handle) => {
      await waitForStep(handle);
      await handle.cancel();
    },
    inputs: {},
    intermediate: {
      inputs: {},
      start: "ask",
      steps: {
        ask: {
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
  },
};

const waitForStep = async (handle: WorkflowHandle): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await handle.query(waitingQueryName)) !== null) {
      return;
    }
    await sleep(50);
  }
  throw new Error("The workflow did not wait");
};

const historyFile = (name: string): string =>
  `${historiesDirectory}v${workflowCodeVersion}-${name}.json`;

/** Records the histories of the scenarios. */
const record = async (): Promise<void> => {
  const environment = await TestWorkflowEnvironment.createLocal({
    server: { executable: { path: inject("temporalCli"), type: "existing-path" } },
  });
  try {
    mkdirSync(historiesDirectory, { recursive: true });
    for (const [name, { drive, inputs, intermediate }] of Object.entries(scenarios)) {
      const taskQueue = randomUUID();
      const worker = await Worker.create({
        activities: createActivities({
          eventLog: createMemoryEventLog(),
          scriptRunner: {
            run: async () => ({ exitCode: 0, signal: null, stderr: "", stdout: "x\n" }),
          },
        }),
        connection: environment.nativeConnection,
        taskQueue,
        workflowsPath,
      });
      await worker.runUntil(async () => {
        const handle = await environment.client.workflow.start(aitw, {
          args: [intermediate, inputs],
          taskQueue,
          workflowId: `replay-${name}`,
        });
        await drive?.(handle);
        await handle.result().catch(() => {});
        writeFileSync(historyFile(name), `${historyToJSON(await handle.fetchHistory())}\n`);
      });
    }
  } finally {
    await environment.teardown();
  }
};

describe("aitw replay", () => {
  it.runIf(process.env.AITW_RECORD_HISTORIES === "1")(
    "records the histories of the scenarios",
    record,
    120_000,
  );

  const files = readdirSync(historiesDirectory).filter((file) => file.endsWith(".json"));

  it("has histories of the current workflow code version", () => {
    expect(files).toEqual(
      expect.arrayContaining(
        Object.keys(scenarios).map((name) => `v${workflowCodeVersion}-${name}.json`),
      ),
    );
  });

  it.each(files)(
    "replays %s",
    async (file) => {
      const history: unknown = JSON.parse(readFileSync(`${historiesDirectory}${file}`, "utf8"));
      await Worker.runReplayHistory({ workflowsPath }, history);
    },
    60_000,
  );
});
