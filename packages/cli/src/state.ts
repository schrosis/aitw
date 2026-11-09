import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { workflowCodeVersion } from "@aitw/engine";

/** The state directory of aitw is not one that only the user can use. */
export class StateDirectoryError extends Error {
  override name = "StateDirectoryError";
}

/**
 * Checks that only the user can use a directory.
 *
 * Another user who can write to the state directory could put a socket in place of the resident
 * process, or read the logs of runs. A symbolic link is rejected, because its target can change
 * after the check.
 *
 * @throws {StateDirectoryError} When the directory is a symbolic link, belongs to another user,
 *   or lets others use it.
 */
const checkPrivateDirectory = (directory: string): void => {
  const stats = lstatSync(directory);
  if (!stats.isDirectory()) {
    throw new StateDirectoryError(
      `The state directory ${directory} must be a directory, not a symbolic link or a file`,
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new StateDirectoryError(`The state directory ${directory} belongs to another user`);
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new StateDirectoryError(
      `Other users can use the state directory ${directory}. Run "chmod 700 ${directory}" to fix it`,
    );
  }
};

/**
 * Returns the directory that keeps the state of aitw, such as logs, creating it when needed.
 *
 * Everything that aitw keeps is inside this directory, so checking it protects the rest.
 *
 * @throws {StateDirectoryError} When other users can use the directory.
 */
export const stateDirectory = (): string => {
  const directory = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "aitw");
  mkdirSync(directory, { mode: 0o700, recursive: true });
  checkPrivateDirectory(directory);
  return directory;
};

/**
 * Returns a short hash of a project root, which keeps the state of each project apart.
 *
 * Pass the real path, so that a project reached through a symbolic link has the same hash.
 */
export const projectHash = (root: string): string =>
  createHash("sha256").update(root).digest("hex").slice(0, 16);

/** Returns the directory that keeps the logs of the runs of a project (B10l). */
export const projectLogDirectory = (root: string): string =>
  join(stateDirectory(), "logs", projectHash(root));

/** Key of the memo of a run that holds the hash of its project. */
export const projectMemoKey = "aitwProject";

/** Key of the memo of a run that holds the name of its workflow, such as `release/notes`. */
export const workflowMemoKey = "aitwWorkflow";

/** Returns the directory that keeps the locks of the runs of a project. */
export const projectLockDirectory = (root: string): string =>
  join(stateDirectory(), "locks", projectHash(root));

/**
 * Returns the task queue that the resident process serves for a project (C12e).
 *
 * The host name keeps the projects of hosts that share a Temporal Server apart. The workflow code
 * version keeps runs of other versions away from this Worker, because replaying them with this
 * code can fail (C12a). A run of another version stays on its task queue until a matching aitw,
 * or `aitw resume --force`, continues it.
 */
export const projectTaskQueue = (root: string): string => {
  const host = hostname()
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/gu, "-");
  return `aitw-${host}-${projectHash(root)}-v${workflowCodeVersion}`;
};
