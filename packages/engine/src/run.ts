import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createPluginRegistry } from "@aitw/core";
import type { EventLog, EventSink, Intermediate, PluginRegistry, ScriptRunner } from "@aitw/core";
import { Client, Connection } from "@temporalio/client";
import { DefaultLogger, NativeConnection, Runtime, Worker } from "@temporalio/worker";
import type { LogLevel } from "@temporalio/worker";

import { createActivities } from "./activities/index.js";
import { answerWaits } from "./answer.js";
import { createMemoryEventLog, followEvents } from "./events.js";
import type { aitw, WorkflowResult } from "./workflows/index.js";

const discardEvents: EventSink = { emit: () => {} };

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
  /** Values of the workflow input, keyed by name. The workflow validates them. */
  inputs?: Readonly<Record<string, unknown>>;
  scriptRunner: ScriptRunner;
  /** Receives progress events of the run, in order. */
  eventSink?: EventSink;
  /**
   * Stores the progress events, so that the Worker and the process that shows the run can be
   * different. Defaults to a log in memory.
   */
  eventLog?: EventLog;
  /** Path of the workflow code. Defaults to {@link workflowsPath}. */
  workflowsPath?: string;
  /** Cancels the workflow, including its running script, when aborted. */
  signal?: AbortSignal;
  /** Plugins whose wait methods answer the wait steps of the run. */
  plugins?: PluginRegistry;
  /**
   * Receives a problem that does not stop the run, such as a progress log that cannot be read.
   * Each kind of problem is reported once per run.
   */
  onWarning?: (message: string) => void;
}

/**
 * Runs a workflow with a Worker that lives only for this run.
 *
 * @throws When the workflow fails, for example because a script step fails.
 */
export const runWorkflow = async ({
  address,
  eventLog = createMemoryEventLog(),
  eventSink = discardEvents,
  inputs = {},
  intermediate,
  name,
  namespace = "default",
  onWarning = () => {},
  plugins = createPluginRegistry(),
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
        activities: createActivities({ eventLog, scriptRunner }),
        connection: workerConnection,
        namespace,
        taskQueue,
        workflowsPath: path,
      });
      const client = new Client({ connection: clientConnection, namespace });

      return await worker.runUntil(async () => {
        const workflowId = `${name}-${id}`;
        const handle = await client.workflow.start<typeof aitw>("aitw", {
          args: [intermediate, inputs],
          taskQueue,
          workflowId,
        });
        // A log that cannot be read would hide every later event, so it is reported once.
        let warned = false;
        const follower = followEvents({
          log: eventLog,
          onError: (error) => {
            if (!warned) {
              warned = true;
              onWarning(
                `Failed to show the progress of the run: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          },
          runId: workflowId,
          sink: eventSink,
        });
        const cancel = (): void => {
          // The result below reports the cancellation, so a failed request is not rethrown.
          handle.cancel().catch(() => {});
        };
        if (signal?.aborted) {
          cancel();
        }
        signal?.addEventListener("abort", cancel, { once: true });
        // Stops answering when the run ends or is interrupted.
        const answering = new AbortController();
        const stopAnswering = (): void => answering.abort();
        signal?.addEventListener("abort", stopAnswering, { once: true });
        // A wait step that cannot be answered would wait forever, so the run is cancelled and
        // reports why it could not be answered.
        let answerFailure: { error: unknown } | undefined;
        const answered = answerWaits({
          handle,
          plugins,
          flush: follower.flush,
          report: async (event) => {
            eventLog.append(workflowId, event);
            await follower.flush();
          },
          signal: answering.signal,
        }).catch((error: unknown) => {
          // An interrupt also stops answering, and the result reports the cancellation.
          if (!answering.signal.aborted) {
            answerFailure = { error };
            cancel();
          }
        });
        try {
          return await handle.result();
        } catch (error) {
          throw answerFailure === undefined ? error : answerFailure.error;
        } finally {
          answering.abort();
          await answered;
          // Events that the last steps stored are shown before the run ends.
          await follower.stop();
          signal?.removeEventListener("abort", cancel);
          signal?.removeEventListener("abort", stopAnswering);
        }
      });
    } finally {
      await clientConnection.close();
    }
  } finally {
    await workerConnection.close();
  }
};
