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
  /** Starts a Worker. Defaults to `startWorker` of `@aitw/engine`. */
  startWorker?: typeof startWorker;
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

const isProject = (root: string): boolean => existsSync(join(root, aitwDirectory));

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
  startWorker: startProjectWorker = startWorker,
}: ProjectWorkersOptions): ProjectWorkers => {
  // Projects to serve, which the file keeps also while their Workers cannot run.
  const roots = new Set<string>();
  // Workers that run or start, keyed by project root, so that a project gets one Worker.
  const workers = new Map<string, Promise<RunningWorker>>();

  const save = (): void => {
    writeFileSync(file, `${JSON.stringify([...roots], null, 2)}\n`, { mode: 0o600 });
  };

  const forget = (root: string, worker: Promise<RunningWorker>): void => {
    // A later Worker of the same project is kept.
    if (workers.get(root) === worker) {
      workers.delete(root);
    }
  };

  const start = (root: string): Promise<RunningWorker> => {
    const taskQueue = projectTaskQueue(root);
    const worker: Promise<RunningWorker> = (async () => {
      prepareEngine();
      const running = await startProjectWorker({
        address,
        eventLog: createFileEventLog({ directory: projectLogDirectory(root) }),
        onError: (error) => {
          log(
            `Worker of ${root} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          // The next request for the project starts a new Worker.
          forget(root, worker);
        },
        scriptRunner: createLocalScriptRunner({ cwd: root }),
        taskQueue,
      });
      log(`serving ${root} on ${taskQueue}`);
      return running;
    })();
    workers.set(root, worker);
    // A Worker that fails to start is forgotten, so that a later request can try again.
    worker.catch(() => forget(root, worker));
    return worker;
  };

  const ensure = async (root: string): Promise<void> => {
    await (workers.get(root) ?? start(root));
  };

  return {
    add: async (root) => {
      if (!isProject(root)) {
        throw new Error(`Not a project, because it has no ${aitwDirectory} directory: ${root}`);
      }
      roots.add(root);
      save();
      await ensure(root);
      return { root, taskQueue: projectTaskQueue(root) };
    },
    list: () =>
      [...roots].map((root) => ({
        root,
        running: workers.has(root),
        taskQueue: projectTaskQueue(root),
      })),
    restore: async () => {
      for (const root of readRoots(file)) {
        // Only a project that was moved or deleted is dropped. A Worker that fails to start,
        // such as when the server cannot be reached, is tried again on the next request.
        if (!isProject(root)) {
          log(`dropped ${root}, because it has no ${aitwDirectory} directory`);
          continue;
        }
        roots.add(root);
        await ensure(root).catch((error: unknown) => {
          log(
            `cannot serve ${root} yet: ${error instanceof Error ? error.message : String(error)}`,
          );
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
