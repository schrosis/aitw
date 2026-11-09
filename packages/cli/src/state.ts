import { createHash } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { workflowCodeVersion } from "@aitw/engine";

import { ensurePrivateDirectory } from "./private-directory.js";

/**
 * Returns the directory that keeps the state of aitw, such as logs, creating it when needed.
 *
 * The socket of the resident process, the locks of runs, and their logs are all in this
 * directory, so checking it protects them.
 *
 * @throws {UnsafeDirectoryError} When the directory is a symbolic link or not a directory,
 *   belongs to another user, lets others use it, or has an ancestor that others can replace.
 */
export const stateDirectory = (): string =>
  ensurePrivateDirectory(
    join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "aitw"),
    "state directory",
  );

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
