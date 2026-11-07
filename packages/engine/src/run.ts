import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { EventSink, Intermediate, ScriptRunner } from "@aitw/core";
import { Client, Connection } from "@temporalio/client";
import { DefaultLogger, NativeConnection, Runtime, Worker } from "@temporalio/worker";
import type { LogLevel } from "@temporalio/worker";

import { createActivities } from "./activities/index.js";
import type { aitw, WorkflowResult } from "./workflows/index.js";

/** Path of the built workflow code that a Worker bundles. */
export const workflowsPath = fileURLToPath(new URL("./workflows.js", import.meta.url));

/** Options of {@link configureRuntime}. */
export interface RuntimeOptions {
  /** Minimum level of the logs that Temporal Workers write. */
  logLevel: LogLevel;
}

/**
 * Configures the Temporal runtime for an application that handles process signals itself.
 *
 * By default, the Temporal runtime shuts down Workers on SIGINT and SIGTERM, which would stop
 * a run before its cancellation completes. This disables that behavior, so pass an
 * `AbortSignal` to {@link runWorkflow} to cancel runs instead.
 *
 * Call it once, before {@link runWorkflow}, because the Temporal runtime is configured only once.
 */
export const configureRuntime = ({ logLevel }: RuntimeOptions): void => {
  Runtime.install({
    logger: new DefaultLogger(logLevel),
    shutdownSignals: [],
    // Native logs are forwarded to the logger so that the same level applies to them.
    telemetryOptions: { logging: { filter: { core: logLevel, other: logLevel }, forward: {} } },
  });
};

/** Options of {@link runWorkflow}. */
export interface RunWorkflowOptions {
  /** Address of the Temporal Server, such as `localhost:7233`. */
  address: string;
  /**
   * Name of the workflow, such as `deploy` or `release/notes`.
   *
   * It prefixes the workflow ID so that runs are easy to find in the Temporal Web UI.
   */
  name: string;
  /** Temporal namespace. Defaults to `default`. */
  namespace?: string;
  intermediate: Intermediate;
  scriptRunner: ScriptRunner;
  /** Receives progress events of the run. */
  eventSink?: EventSink;
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
  eventSink,
  intermediate,
  name,
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
        activities: createActivities({ eventSink, scriptRunner }),
        connection: workerConnection,
        namespace,
        taskQueue,
        workflowsPath: path,
      });
      const client = new Client({ connection: clientConnection, namespace });

      return await worker.runUntil(async () => {
        const handle = await client.workflow.start<typeof aitw>("aitw", {
          args: [intermediate],
          taskQueue,
          workflowId: `${name}-${id}`,
        });
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
