import { workflowCodeVersion } from "@aitw/engine";

import type { CommandContext } from "../commands/load.js";
import { loadProjectConfig } from "../config.js";
import { openServer } from "../server.js";
import type { OpenedServer, ServerOptions } from "../server.js";
import { getDaemonStatus, registerProject } from "./client.js";
import type { DaemonProject } from "./client.js";
import { daemonPaths } from "./paths.js";

/** Thrown when a command needs the resident process, and it does not run or cannot be reached. */
export class DaemonUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `aitw daemon ${reason}. Run "aitw daemon start", choose a server with --dev or --address, or set temporal.address in .aitw/config.yaml`,
    );
    this.name = "DaemonUnavailableError";
  }
}

/** The Temporal Server of the resident process, for a command. */
export interface DaemonConnection {
  /** Temporal Server of the resident process. The command does not stop it. */
  server: OpenedServer;
  /**
   * Project that the resident process serves, or `undefined` when the resident process has
   * another version, so that the command runs its own Worker on the same server.
   */
  project?: DaemonProject | undefined;
}

/**
 * Asks the resident process of this host to serve a project.
 *
 * A resident process of another version is not asked to serve it, because it could not run
 * definitions or runs of this version. The command then runs its own Worker on the server of the
 * resident process, and says why.
 *
 * @param version Version of this aitw.
 * @throws {DaemonUnavailableError} When the resident process does not run or cannot be reached.
 */
export const connectDaemon = async (
  root: string,
  version: string,
  context: CommandContext,
): Promise<DaemonConnection> => {
  const paths = daemonPaths();
  const status = await getDaemonStatus(paths).catch((error: unknown) => {
    throw new DaemonUnavailableError(
      `cannot be reached: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (status === undefined) {
    throw new DaemonUnavailableError("is not running");
  }
  const server: OpenedServer = {
    address: status.address,
    durable: true,
    // Later commands find the resident process again by themselves.
    options: "",
    stop: async () => {},
  };
  if (status.version !== version || status.workflowCodeVersion !== workflowCodeVersion) {
    context.stderr(
      `aitw daemon: runs aitw ${status.version}, and this is aitw ${version}, so this command runs its own Worker. Run "aitw daemon stop" and start it again to use it\n`,
    );
    return { server };
  }
  return { project: await registerProject(paths, root), server };
};

/** The Temporal Server that a command uses, and the task queue that the resident process serves. */
export interface CommandServer {
  server: OpenedServer;
  /** Task queue that the resident process serves for the project, when it runs the steps. */
  servedTaskQueue?: string | undefined;
}

/**
 * Asks the resident process to serve a project on the server that the project names, when it runs
 * with the same version.
 *
 * The resident process runs the Worker of the project on that server too. The project names its
 * server, so the command runs its own Worker without the resident process. When the resident
 * process runs but is not used, the command says why, because a run then stops with the command.
 *
 * @returns The task queue that it serves, or `undefined` when the command runs its own Worker.
 */
const daemonOn = async (
  address: string,
  root: string,
  version: string,
  context: CommandContext,
): Promise<string | undefined> => {
  const paths = daemonPaths();
  let status;
  try {
    status = await getDaemonStatus(paths);
  } catch (error) {
    context.stderr(
      `aitw daemon: cannot be reached, so this command runs its own Worker: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return undefined;
  }
  if (status === undefined) {
    return undefined;
  }
  if (status.version !== version || status.workflowCodeVersion !== workflowCodeVersion) {
    context.stderr(
      `aitw daemon: runs aitw ${status.version}, and this is aitw ${version}, so this command runs its own Worker. Run "aitw daemon stop" and start it again to use it\n`,
    );
    return undefined;
  }
  const project = await registerProject(paths, root);
  // The resident process reads the configuration file again, which may have changed since.
  if (project.address !== address) {
    context.stderr(
      `aitw daemon: serves the project at ${project.address ?? status.address}, and temporal.address of the project is ${address}, so this command runs its own Worker\n`,
    );
    return undefined;
  }
  return project.taskQueue;
};

/**
 * Opens the Temporal Server of a command.
 *
 * The options of the command come first. Without them, the server is the one that
 * `temporal.address` in the configuration file of the project names, or that of the resident
 * process.
 *
 * @param version Version of this aitw, which the resident process must have to run the steps.
 * @throws {DaemonUnavailableError} When no server is named and the resident process is not
 *   available.
 * @throws {ProjectConfigError} When the configuration file of the project is invalid.
 */
export const openCommandServer = async (
  { server, version }: { server?: ServerOptions | undefined; version: string },
  root: string,
  context: CommandContext,
  signal: AbortSignal,
): Promise<CommandServer> => {
  if (server !== undefined) {
    return { server: await openServer(server, context, signal) };
  }
  const address = (await loadProjectConfig(root, context.cwd)).temporal?.address;
  if (address !== undefined) {
    const opened = await openServer({ address, type: "address" }, context, signal);
    return {
      // Later commands read the configuration file again.
      server: { ...opened, options: "" },
      servedTaskQueue: await daemonOn(address, root, version, context),
    };
  }
  const daemon = await connectDaemon(root, version, context);
  return { server: daemon.server, servedTaskQueue: daemon.project?.taskQueue };
};
