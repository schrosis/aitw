import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createPluginRegistry } from "@aitw/core";
import type { EventLog, EventSink, Intermediate, PluginRegistry, ScriptRunner } from "@aitw/core";
import { Client, Connection } from "@temporalio/client";
import type { WorkflowHandle } from "@temporalio/client";
import { DefaultLogger, NativeConnection, Runtime, Worker } from "@temporalio/worker";
import type { LogLevel } from "@temporalio/worker";

import { createActivities } from "./activities/index.js";
import { answerWaits } from "./answer.js";
import { createMemoryEventLog, followEvents } from "./events.js";
import type { EventFollower } from "./events.js";
import type { aitw } from "./workflows/index.js";

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

/** How a run ended for the process that followed it. */
export type RunOutcome =
  | { status: "completed"; workflowId: string; executedSteps: string[] }
  /** The process stopped following, and the run waits in Temporal until it is resumed. */
  | { status: "detached"; workflowId: string };

/** Options of {@link runWorkflow} and {@link resumeWorkflow}. */
export interface FollowOptions {
  /** Address of the Temporal Server, such as `localhost:7233`. */
  address: string;
  /** Temporal namespace. Defaults to `default`. */
  namespace?: string;
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
  /**
   * Stops following the run when aborted, and leaves the workflow running in Temporal.
   *
   * The Worker of this process stops taking new tasks, and waits for a running script to
   * finish, so that the run can be resumed.
   */
  detach?: AbortSignal;
  /** Plugins whose wait methods answer the wait steps of the run. */
  plugins?: PluginRegistry;
  /**
   * Receives a problem that does not stop the run, such as a progress log that cannot be read.
   * Each kind of problem is reported once per run.
   */
  onWarning?: (message: string) => void;
}

/** Options of {@link runWorkflow}. */
export interface RunWorkflowOptions extends FollowOptions {
  /**
   * Name of the workflow, such as `deploy` or `release/notes`.
   *
   * It prefixes the workflow ID so that runs are easy to find in the Temporal Web UI.
   */
  name: string;
  intermediate: Intermediate;
  /** Values of the workflow input, keyed by name. The workflow validates them. */
  inputs?: Readonly<Record<string, unknown>>;
  /** Values that mark the run, such as its project, for {@link listRunningWorkflows}. */
  memo?: Readonly<Record<string, string>>;
  /** Called with the workflow ID as soon as the workflow starts. */
  onStart?: (workflowId: string) => void;
}

/** Options of {@link resumeWorkflow}. */
export interface ResumeWorkflowOptions extends FollowOptions {
  /** ID of a running workflow. */
  workflowId: string;
  /** Cancels the workflow as soon as it is resumed, such as for `aitw cancel`. */
  cancel?: boolean;
}

/**
 * Time that a detaching Worker waits for a running script to finish.
 *
 * A script that is stopped fails its step, and the run could not be resumed.
 */
const detachGraceTime = "1 day";

const withConnections = async <T>(
  address: string,
  use: (client: Connection, worker: NativeConnection) => Promise<T>,
): Promise<T> => {
  const workerConnection = await NativeConnection.connect({ address });
  try {
    const clientConnection = await Connection.connect({ address });
    try {
      return await use(clientConnection, workerConnection);
    } finally {
      await clientConnection.close();
    }
  } finally {
    await workerConnection.close();
  }
};

/**
 * Runs a Worker for a task queue and follows a run until it ends or the process detaches.
 *
 * @param open Starts or finds the workflow, after the Worker is ready.
 */
const follow = async (
  options: FollowOptions & { taskQueue: string; cancelNow?: boolean },
  connections: { client: Client; connection: Connection; worker: NativeConnection },
  open: () => Promise<WorkflowHandle<typeof aitw>>,
): Promise<RunOutcome> => {
  const {
    cancelNow = false,
    detach,
    eventLog = createMemoryEventLog(),
    eventSink = discardEvents,
    namespace = "default",
    onWarning = () => {},
    plugins = createPluginRegistry(),
    scriptRunner,
    signal,
    taskQueue,
    workflowsPath: path = workflowsPath,
  } = options;
  const worker = await Worker.create({
    activities: createActivities({ eventLog, scriptRunner }),
    connection: connections.worker,
    namespace,
    shutdownGraceTime: detachGraceTime,
    taskQueue,
    workflowsPath: path,
  });

  let handle: WorkflowHandle<typeof aitw> | undefined;
  let follower: EventFollower | undefined;
  let outcome: RunOutcome;
  try {
    outcome = await worker.runUntil(async (): Promise<RunOutcome> => {
      handle = await open();
      const { workflowId } = handle;
      const current = handle;
      // A log that cannot be read would hide every later event, so it is reported once.
      let warned = false;
      follower = followEvents({
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
      const visible = follower;
      const cancel = (): void => {
        // The result below reports the cancellation, so a failed request is not rethrown.
        current.cancel().catch(() => {});
      };
      if (signal?.aborted === true || cancelNow) {
        cancel();
      }
      signal?.addEventListener("abort", cancel, { once: true });
      // Stops answering when the run ends, is interrupted, or detaches.
      const answering = new AbortController();
      const stopAnswering = (): void => answering.abort();
      signal?.addEventListener("abort", stopAnswering, { once: true });
      detach?.addEventListener("abort", stopAnswering, { once: true });
      // A wait step that cannot be answered would wait forever, so the run is cancelled and
      // reports why it could not be answered.
      let answerFailure: { error: unknown } | undefined;
      // A run that is cancelled right away is not answered.
      const answeringTask = cancelNow
        ? Promise.resolve()
        : answerWaits({
            flush: visible.flush,
            handle: current,
            plugins,
            report: async (event) => {
              eventLog.append(workflowId, event);
              await visible.flush();
            },
            signal: answering.signal,
          });
      const answered = answeringTask.catch((error: unknown) => {
        // An interrupt also stops answering, and the result reports the cancellation.
        if (!answering.signal.aborted) {
          answerFailure = { error };
          cancel();
        }
      });
      const detached = new Promise<RunOutcome>((resolve) => {
        const onDetach = (): void => resolve({ status: "detached", workflowId });
        if (detach?.aborted === true) {
          onDetach();
        }
        detach?.addEventListener("abort", onDetach, { once: true });
      });
      // Waiting for the result is a long call, which is aborted when the run detaches. A call
      // that is left running would retry on a closed connection and crash the process.
      const waitingForResult = new AbortController();
      const result = connections.connection.withAbortSignal(waitingForResult.signal, async () =>
        current.result(),
      );
      try {
        return await Promise.race([
          result.then((value): RunOutcome => ({ ...value, status: "completed", workflowId })),
          detached,
        ]);
      } catch (error) {
        throw answerFailure === undefined ? error : answerFailure.error;
      } finally {
        waitingForResult.abort();
        // The result of a detached run is not needed.
        result.catch(() => {});
        answering.abort();
        await answered;
        signal?.removeEventListener("abort", cancel);
        signal?.removeEventListener("abort", stopAnswering);
        detach?.removeEventListener("abort", stopAnswering);
      }
    });
  } finally {
    // The Worker has stopped, after the running script finished. Its events are shown before
    // the outcome, also when the run failed.
    await follower?.stop();
  }

  // The run may have ended while the Worker waited for the last script. A run that cannot be
  // resumed is reported like any other end, and the result throws when it failed.
  if (outcome.status === "detached" && handle !== undefined) {
    const { status } = await handle.describe();
    if (status.name !== "RUNNING") {
      return { ...(await handle.result()), status: "completed", workflowId: outcome.workflowId };
    }
  }
  return outcome;
};

/**
 * Starts a workflow and follows it with a Worker that lives only for this run.
 *
 * @throws When the workflow fails, for example because a script step fails.
 */
export const runWorkflow = async (options: RunWorkflowOptions): Promise<RunOutcome> => {
  const {
    address,
    inputs = {},
    intermediate,
    memo,
    name,
    namespace = "default",
    onStart = () => {},
  } = options;
  const id = randomUUID();
  // A task queue for this run keeps other Workers from picking up its tasks.
  const taskQueue = `aitw-${id}`;
  return withConnections(address, async (clientConnection, workerConnection) => {
    const client = new Client({ connection: clientConnection, namespace });
    return follow(
      { ...options, taskQueue },
      { client, connection: clientConnection, worker: workerConnection },
      async () => {
        const handle = await client.workflow.start<typeof aitw>("aitw", {
          args: [intermediate, inputs],
          ...(memo === undefined ? {} : { memo: { ...memo } }),
          taskQueue,
          workflowId: `${name}-${id}`,
        });
        onStart(handle.workflowId);
        return handle;
      },
    );
  });
};

/**
 * Follows a running workflow with a Worker on its task queue, such as after the process that
 * started it exited.
 *
 * @throws When the workflow is not running, or when it fails.
 */
export const resumeWorkflow = async (options: ResumeWorkflowOptions): Promise<RunOutcome> => {
  const { address, cancel = false, namespace = "default", workflowId } = options;
  return withConnections(address, async (clientConnection, workerConnection) => {
    const client = new Client({ connection: clientConnection, namespace });
    const handle = client.workflow.getHandle<typeof aitw>(workflowId);
    const { status, taskQueue } = await handle.describe();
    if (status.name !== "RUNNING") {
      throw new Error(`Workflow ${workflowId} is not running: ${status.name.toLowerCase()}`);
    }
    return follow(
      { ...options, cancelNow: cancel, taskQueue },
      { client, connection: clientConnection, worker: workerConnection },
      async () => handle,
    );
  });
};

/** A running workflow that {@link listRunningWorkflows} returns. */
export interface RunningWorkflow {
  workflowId: string;
  startTime: Date;
  /** Values that mark the run, from `memo` of {@link runWorkflow}. */
  memo: Readonly<Record<string, unknown>>;
}

/** Options of {@link listRunningWorkflows}. */
export interface ListRunningWorkflowsOptions {
  address: string;
  namespace?: string;
  /** Returns only the runs whose memo has these values, such as the runs of a project. */
  memo?: Readonly<Record<string, string>>;
}

/** Lists the running workflows of aitw, most recent first. */
export const listRunningWorkflows = async ({
  address,
  memo = {},
  namespace = "default",
}: ListRunningWorkflowsOptions): Promise<RunningWorkflow[]> => {
  const connection = await Connection.connect({ address });
  try {
    const client = new Client({ connection, namespace });
    const runs: RunningWorkflow[] = [];
    for await (const info of client.workflow.list({
      query: "WorkflowType = 'aitw' AND ExecutionStatus = 'Running'",
    })) {
      const values = info.memo ?? {};
      if (Object.entries(memo).every(([key, value]) => values[key] === value)) {
        runs.push({ memo: values, startTime: info.startTime, workflowId: info.workflowId });
      }
    }
    return runs.toSorted((a, b) => b.startTime.getTime() - a.startTime.getTime());
  } finally {
    await connection.close();
  }
};
