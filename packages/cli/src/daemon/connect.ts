import { workflowCodeVersion } from "@aitw/engine";

import type { CommandContext } from "../commands/load.js";
import { openServer } from "../server.js";
import type { OpenedServer, ServerOptions } from "../server.js";
import { getDaemonStatus, registerProject } from "./client.js";
import type { DaemonProject } from "./client.js";
import { daemonPaths } from "./paths.js";

/** Thrown when a command needs the resident process, and it does not run or cannot be reached. */
export class DaemonUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `aitw daemon ${reason}. Run "aitw daemon start", or choose a server with --dev or --address`,
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
 * Opens the Temporal Server that the options of a command name, or that of the resident process
 * when they name none.
 *
 * @param version Version of this aitw, which the resident process must have to run the steps.
 * @throws {DaemonUnavailableError} When no server is named and the resident process is not
 *   available.
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
  const daemon = await connectDaemon(root, version, context);
  return { server: daemon.server, servedTaskQueue: daemon.project?.taskQueue };
};
