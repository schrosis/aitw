import type { EventLog, ScriptRunner } from "@aitw/core";
import { NativeConnection, Worker } from "@temporalio/worker";

import { createActivities } from "./activities/index.js";
import { workflowsPath } from "./run.js";

/** Options of {@link startWorker}. */
export interface StartWorkerOptions {
  /** Address of the Temporal Server. */
  address: string;
  /** Temporal namespace. Defaults to `default`. */
  namespace?: string;
  /** Task queue that the Worker serves, such as of a project. */
  taskQueue: string;
  scriptRunner: ScriptRunner;
  /** Stores the progress events of the runs of the task queue. */
  eventLog: EventLog;
  /** Path of the workflow code. Defaults to {@link workflowsPath}. */
  workflowsPath?: string;
  /** Receives a failure of the Worker after it started. */
  onError?: (error: unknown) => void;
}

/** A Worker that runs until it is stopped. */
export interface RunningWorker {
  /**
   * Stops taking tasks, waits for running scripts to finish, and closes the connection.
   *
   * A script that is stopped fails its step, and the run could not be resumed.
   */
  stop: () => Promise<void>;
}

/**
 * Starts a Worker that serves a task queue until it is stopped, such as for a resident process.
 *
 * @throws When the Worker cannot start, such as when the server cannot be reached.
 */
export const startWorker = async ({
  address,
  eventLog,
  namespace = "default",
  onError = () => {},
  scriptRunner,
  taskQueue,
  workflowsPath: path = workflowsPath,
}: StartWorkerOptions): Promise<RunningWorker> => {
  const connection = await NativeConnection.connect({ address });
  try {
    const worker = await Worker.create({
      activities: createActivities({ eventLog, scriptRunner }),
      connection,
      namespace,
      // Stopping waits for running scripts, as when a run detaches.
      shutdownGraceTime: "1 day",
      taskQueue,
      workflowsPath: path,
    });
    const running = worker.run().catch(onError);
    return {
      stop: async () => {
        if (worker.getState() === "RUNNING") {
          worker.shutdown();
        }
        await running;
        await connection.close();
      },
    };
  } catch (error) {
    await connection.close();
    throw error;
  }
};
