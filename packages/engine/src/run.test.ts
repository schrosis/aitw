import { fileURLToPath } from "node:url";

import { intermediateVersion } from "@aitw/core";
import type { Intermediate, ScriptRequest } from "@aitw/core";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { runWorkflow } from "./run.ts";

const intermediate: Intermediate = {
  start: "fetch",
  steps: {
    fetch: {
      input: {},
      next: { type: "end" },
      output: {},
      run: "./fetch.sh",
      timeoutMs: 5000,
      type: "script",
    },
  },
  version: intermediateVersion,
  input: {},
};

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
      input: { title: "hello" },
      intermediate: {
        ...intermediate,
        input: { title: { required: true, type: "string" } },
        steps: {
          fetch: {
            input: { title: "${{ workflow.input.title }}" },
            next: { type: "end" },
            output: {},
            run: "./fetch.sh ${{ input.title }}",
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
});
