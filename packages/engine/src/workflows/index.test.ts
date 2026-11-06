import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { smokeWorkflow } from "./index.ts";

describe("smokeWorkflow", () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createLocal();
  }, 120_000);

  afterAll(async () => {
    await environment?.teardown();
  });

  it("runs on a local Temporal server", async () => {
    const taskQueue = randomUUID();
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(new URL("./index.ts", import.meta.url)),
    });

    const result = await worker.runUntil(
      environment.client.workflow.execute(smokeWorkflow, {
        args: ["aitw"],
        taskQueue,
        workflowId: randomUUID(),
      }),
    );

    expect(result).toBe("Hello, aitw!");
  }, 120_000);
});
