import { workflowCodeVersion } from "@aitw/engine";

import type { CommandContext } from "../commands/load.js";
import type { OpenedServer } from "../server.js";
import { getDaemonStatus, registerProject } from "./client.js";
import type { DaemonProject } from "./client.js";
import { daemonPaths } from "./paths.js";

/** A resident process that serves a project for a command. */
export interface DaemonConnection {
  /** Temporal Server of the resident process. The command does not stop it. */
  server: OpenedServer;
  project: DaemonProject;
}

/**
 * Asks the resident process of this host to serve a project, when it runs.
 *
 * A resident process of another version is not used, because it could not run definitions or
 * runs of this version. The command then runs its own Worker, and says why.
 *
 * @param version Version of this aitw.
 * @returns The connection, or `undefined` when the command runs its own Worker.
 */
export const connectDaemon = async (
  root: string,
  version: string,
  context: CommandContext,
): Promise<DaemonConnection | undefined> => {
  const paths = daemonPaths();
  const status = await getDaemonStatus(paths).catch((error: unknown) => {
    context.stderr(
      `aitw daemon: cannot be reached, so this command runs its own Worker: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return undefined;
  });
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
  return {
    project,
    server: {
      address: status.address,
      durable: true,
      // Later commands find the resident process again by themselves.
      options: "",
      stop: async () => {},
    },
  };
};
