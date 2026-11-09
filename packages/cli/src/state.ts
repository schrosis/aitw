import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

/** Returns the directory that keeps the state of aitw, such as logs. */
export const stateDirectory = (): string =>
  join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "aitw");

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
