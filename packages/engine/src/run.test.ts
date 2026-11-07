import { fileURLToPath } from "node:url";

import { intermediateVersion } from "@aitw/core";
import type { Intermediate, ScriptRequest } from "@aitw/core";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
};

describe("runWorkflow", () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal();
  }, 120_000);

  afterAll(async () => {
    await environment?.teardown();
  });

  const run = async (exitCode: number) => {
    const requests: ScriptRequest[] = [];
    const result = runWorkflow({
      address: environment.address,
      intermediate,
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

  it("throws when the workflow fails", async () => {
    const { result } = await run(1);

    await expect(result).rejects.toMatchObject({ cause: { cause: { type: "ScriptFailed" } } });
  }, 60_000);
});
