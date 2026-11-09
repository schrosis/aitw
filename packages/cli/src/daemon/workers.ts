import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createFileEventLog } from "@aitw/adapter-event-log-file";
import { createLocalScriptRunner } from "@aitw/adapter-script-local";
import { startWorker } from "@aitw/engine";
import type { RunningWorker } from "@aitw/engine";

import { projectLogDirectory, projectTaskQueue } from "../state.js";
import { aitwDirectory } from "../workflows.js";
import type { DaemonProject } from "./client.js";

/** Options of {@link createProjectWorkers}. */
export interface ProjectWorkersOptions {
  /** Address of the Temporal Server. */
  address: string;
  /** File that keeps the projects across restarts. */
  file: string;
  /** Writes a line to the log of the resident process. */
  log: (message: string) => void;
  /**
   * Prepares the workflow engine before the first Worker starts.
   *
   * A prepared engine keeps the process alive until its Workers stop, so it is prepared only
   * when a project needs a Worker.
   */
  prepareEngine: () => void;
}

/** The Workers of the projects that the resident process serves. */
export interface ProjectWorkers {
  /** Serves a project, starting its Worker unless it already runs. */
  add: (root: string) => Promise<DaemonProject>;
  /** Starts the Workers of the projects that the file keeps. */
  restore: () => Promise<void>;
  list: () => DaemonProject[];
  /** Stops every Worker, after the scripts that they run finish. */
  stopAll: () => Promise<void>;
}

const readRoots = (file: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((root) => typeof root === "string") : [];
  } catch {
    return [];
  }
};

/**
 * Creates the Workers of projects, one for each project on the task queue of the project.
 *
 * Scripts run in the project root, and their progress goes to the log of the project.
 */
export const createProjectWorkers = ({
  address,
  file,
  log,
  prepareEngine,
}: ProjectWorkersOptions): ProjectWorkers => {
  // Workers that run or start, keyed by project root, so that a project gets one Worker.
  const workers = new Map<string, Promise<RunningWorker>>();

  const save = (): void => {
    writeFileSync(file, `${JSON.stringify([...workers.keys()], null, 2)}\n`, { mode: 0o600 });
  };

  const start = async (root: string): Promise<RunningWorker> => {
    prepareEngine();
    const taskQueue = projectTaskQueue(root);
    const worker = await startWorker({
      address,
      eventLog: createFileEventLog({ directory: projectLogDirectory(root) }),
      onError: (error) => {
        log(`Worker of ${root} failed: ${error instanceof Error ? error.message : String(error)}`);
      },
      scriptRunner: createLocalScriptRunner({ cwd: root }),
      taskQueue,
    });
    log(`serving ${root} on ${taskQueue}`);
    return worker;
  };

  const add = async (root: string): Promise<DaemonProject> => {
    if (!existsSync(join(root, aitwDirectory))) {
      throw new Error(`Not a project, because it has no ${aitwDirectory} directory: ${root}`);
    }
    let worker = workers.get(root);
    if (worker === undefined) {
      worker = start(root);
      workers.set(root, worker);
      // A Worker that fails to start is forgotten, so that a later request can try again.
      worker.catch(() => workers.delete(root));
    }
    await worker;
    save();
    return { root, taskQueue: projectTaskQueue(root) };
  };

  return {
    add,
    list: () => [...workers.keys()].map((root) => ({ root, taskQueue: projectTaskQueue(root) })),
    restore: async () => {
      for (const root of readRoots(file)) {
        // A project that was moved or deleted is dropped.
        await add(root).catch((error: unknown) => {
          log(`dropped ${root}: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      save();
    },
    stopAll: async () => {
      const running = await Promise.allSettled(workers.values());
      await Promise.all(
        running.map(async (result) =>
          result.status === "fulfilled" ? result.value.stop() : undefined,
        ),
      );
    },
  };
};
