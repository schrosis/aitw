import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { Intermediate, ScriptRunner } from "@aitw/core";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";

import { createActivities } from "./activities/index.js";
import type { interpreterWorkflow, WorkflowResult } from "./workflows/index.js";

/** Path of the built workflow code that a Worker bundles. */
export const workflowsPath = fileURLToPath(new URL("./workflows.js", import.meta.url));

/** Options of {@link runWorkflow}. */
export interface RunWorkflowOptions {
  /** Address of the Temporal Server, such as `localhost:7233`. */
  address: string;
  /** Temporal namespace. Defaults to `default`. */
  namespace?: string;
  intermediate: Intermediate;
  scriptRunner: ScriptRunner;
  /** Path of the workflow code. Defaults to {@link workflowsPath}. */
  workflowsPath?: string;
  /** Cancels the workflow, including its running script, when aborted. */
  signal?: AbortSignal;
}

/**
 * Runs a workflow with a Worker that lives only for this run.
 *
 * @throws When the workflow fails, for example because a script step fails.
 */
export const runWorkflow = async ({
  address,
  intermediate,
  namespace = "default",
  scriptRunner,
  signal,
  workflowsPath: path = workflowsPath,
}: RunWorkflowOptions): Promise<WorkflowResult> => {
  const id = randomUUID();
  // A task queue for this run keeps other Workers from picking up its tasks.
  const taskQueue = `aitw-${id}`;

  const workerConnection = await NativeConnection.connect({ address });
  try {
    const clientConnection = await Connection.connect({ address });
    try {
      const worker = await Worker.create({
        activities: createActivities({ scriptRunner }),
        connection: workerConnection,
        namespace,
        taskQueue,
        workflowsPath: path,
      });
      const client = new Client({ connection: clientConnection, namespace });

      return await worker.runUntil(async () => {
        const handle = await client.workflow.start<typeof interpreterWorkflow>(
          "interpreterWorkflow",
          { args: [intermediate], taskQueue, workflowId: `aitw-${id}` },
        );
        const cancel = (): void => {
          // The result below reports the cancellation, so a failed request is not rethrown.
          handle.cancel().catch(() => {});
        };
        if (signal?.aborted) {
          cancel();
        }
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          return await handle.result();
        } finally {
          signal?.removeEventListener("abort", cancel);
        }
      });
    } finally {
      await clientConnection.close();
    }
  } finally {
    await workerConnection.close();
  }
};
