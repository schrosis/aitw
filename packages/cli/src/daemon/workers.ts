import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createFileEventLog } from "@aitw/adapter-event-log-file";
import { createLocalScriptRunner } from "@aitw/adapter-script-local";
import { createAiRunner } from "@aitw/core";
import { startWorker } from "@aitw/engine";
import type { RunningWorker } from "@aitw/engine";

import { loadProjectConfig } from "../config.js";
import { loadEncryptionKey } from "../encryption.js";
import { createEnvironmentReader } from "../environment.js";
import { createRegistry } from "../plugins.js";
import { projectLogDirectory, projectTaskQueue } from "../state.js";
import { aitwDirectory } from "../workflows.js";
import type { DaemonProject } from "./client.js";

/** Options of {@link createProjectWorkers}. */
export interface ProjectWorkersOptions {
  /**
   * Address of the Temporal Server of the resident process, for the projects that do not name
   * theirs with `temporal.address` in `.aitw/config.yaml`.
   */
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
  /**
   * Serves a project, starting its Worker unless it already runs on the server of the project.
   *
   * The configuration file of the project is read again, so that a Worker moves to the server
   * that the project names now.
   */
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

/** A Worker of a project, and the Temporal Server that it uses. */
interface ServedWorker {
  address: string;
  worker: Promise<RunningWorker>;
}

/**
 * Creates the Workers of projects, one for each project on the task queue of the project.
 *
 * Each Worker uses the Temporal Server that the project names, or that of the resident process.
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
  const workers = new Map<string, ServedWorker>();
  // Workers on servers that their projects no longer name. They keep serving the runs that
  // started there until the resident process stops.
  const previous: Promise<RunningWorker>[] = [];

  const save = (): void => {
    writeFileSync(file, `${JSON.stringify([...roots], null, 2)}\n`, { mode: 0o600 });
  };

  const forget = (root: string, worker: Promise<RunningWorker>): void => {
    // A later Worker of the same project is kept.
    if (workers.get(root)?.worker === worker) {
      workers.delete(root);
    }
  };

  /** Returns the Temporal Server of a project. */
  const serverOf = async (root: string): Promise<string> =>
    (await loadProjectConfig(root, root)).temporal?.address ?? address;

  const start = (root: string, serverAddress: string): Promise<RunningWorker> => {
    const taskQueue = projectTaskQueue(root);
    const worker: Promise<RunningWorker> = (async () => {
      prepareEngine();
      const running = await startProjectWorker({
        address: serverAddress,
        aiRunner: createAiRunner({ cwd: root, plugins: createRegistry() }),
        encryptionKey: loadEncryptionKey(),
        eventLog: createFileEventLog({ directory: projectLogDirectory(root) }),
        onError: (error) => {
          log(
            `Worker of ${root} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          // The next request for the project starts a new Worker.
          forget(root, worker);
        },
        readEnvironment: createEnvironmentReader(root),
        scriptRunner: createLocalScriptRunner({ cwd: root }),
        taskQueue,
      });
      log(
        `serving ${root} on ${taskQueue}${serverAddress === address ? "" : ` at ${serverAddress}`}`,
      );
      return running;
    })();
    workers.set(root, { address: serverAddress, worker });
    // A Worker that fails to start is forgotten, so that a later request can try again.
    worker.catch(() => forget(root, worker));
    return worker;
  };

  /**
   * Starts the Worker of a project on its server, unless it runs there.
   *
   * @returns The address of the server.
   */
  const ensure = async (root: string): Promise<string> => {
    const serverAddress = await serverOf(root);
    const current = workers.get(root);
    if (current?.address === serverAddress) {
      await current.worker;
      return serverAddress;
    }
    if (current !== undefined) {
      log(
        `${root} now uses ${serverAddress}. Its Worker at ${current.address} keeps serving the runs there until aitw daemon stops`,
      );
      previous.push(current.worker);
    }
    await start(root, serverAddress);
    return serverAddress;
  };

  return {
    add: async (root) => {
      if (!isProject(root)) {
        throw new Error(`Not a project, because it has no ${aitwDirectory} directory: ${root}`);
      }
      roots.add(root);
      save();
      const serverAddress = await ensure(root);
      return { address: serverAddress, root, taskQueue: projectTaskQueue(root) };
    },
    list: () =>
      [...roots].map((root) => {
        const served = workers.get(root);
        return {
          ...(served === undefined ? {} : { address: served.address }),
          root,
          running: served !== undefined,
          taskQueue: projectTaskQueue(root),
        };
      }),
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
      const running = await Promise.allSettled([
        ...[...workers.values()].map(({ worker }) => worker),
        ...previous,
      ]);
      await Promise.all(
        running.map(async (result) =>
          result.status === "fulfilled" ? result.value.stop() : undefined,
        ),
      );
    },
  };
};
