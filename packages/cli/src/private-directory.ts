import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** A directory of ugoke that other users could use or replace. */
export class UnsafeDirectoryError extends Error {
  override name = "UnsafeDirectoryError";
}

const stickyBit = 0o1000;

/**
 * Checks that only the user or root can replace the entries of each ancestor, like the
 * `StrictModes` of OpenSSH.
 *
 * Another user who can write to an ancestor could rename the directory after it is checked, and
 * put their own in its place. A sticky directory such as `/tmp` is allowed, because other users
 * cannot rename what they do not own in it.
 */
const checkAncestors = (directory: string, label: string, uid: number): void => {
  for (let ancestor = dirname(directory); ; ancestor = dirname(ancestor)) {
    const stats = lstatSync(ancestor);
    const writable = (stats.mode & 0o022) !== 0 && (stats.mode & stickyBit) === 0;
    if ((stats.uid !== uid && stats.uid !== 0) || writable) {
      throw new UnsafeDirectoryError(
        `The ${label} ${directory} is unsafe, because other users can replace ${ancestor}`,
      );
    }
    if (dirname(ancestor) === ancestor) {
      return;
    }
  }
};

/**
 * Creates a directory that only the user can use, or checks an existing one.
 *
 * Another user who could use or replace it could, for example, put a socket in place of the
 * resident process, read the logs of runs, or put an executable in the cache. Symbolic links in
 * the parent are resolved first, and the returned path has none, so that what was checked is
 * what is used.
 *
 * @param path Directory to create.
 * @param label Name of the directory in messages, such as `state directory`.
 * @returns The real path of the directory.
 * @throws {UnsafeDirectoryError} When the directory is a symbolic link or not a directory,
 *   belongs to another user, lets others use it, or has an ancestor that others can replace.
 */
export const ensurePrivateDirectory = (path: string, label: string): string => {
  mkdirSync(path, { mode: 0o700, recursive: true });
  const parent = realpathSync(dirname(path));
  const directory = join(parent, basename(path));
  const uid = process.getuid?.();
  // Permissions and owners are POSIX ideas, which ugoke relies on only where they exist.
  if (uid === undefined) {
    return directory;
  }

  checkAncestors(directory, label, uid);
  const stats = lstatSync(directory);
  if (!stats.isDirectory()) {
    throw new UnsafeDirectoryError(
      `The ${label} ${directory} must be a directory, not a symbolic link or a file`,
    );
  }
  if (stats.uid !== uid) {
    throw new UnsafeDirectoryError(`The ${label} ${directory} belongs to another user`);
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new UnsafeDirectoryError(
      `Other users can use the ${label} ${directory}. Run "chmod 700 ${directory}" to fix it`,
    );
  }
  return directory;
};
