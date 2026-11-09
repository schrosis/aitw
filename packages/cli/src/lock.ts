import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A lock that keeps one process following a run. */
export interface RunLock {
  release: () => void;
}

/** Thrown when another process already follows a run. */
export class RunLockedError extends Error {
  /** Process that holds the lock, or `undefined` when the lock file cannot be read. */
  readonly pid: number | undefined;

  constructor(workflowId: string, pid: number | undefined, file: string) {
    super(
      pid === undefined
        ? `Another process already follows ${workflowId}. Remove ${file} if no process does`
        : `Another process (${pid}) already follows ${workflowId}`,
    );
    this.name = "RunLockedError";
    this.pid = pid;
  }
}

const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means that the process exists but belongs to another user.
    return hasCode(error, "EPERM");
  }
};

/** Returns the process in a lock file, or `undefined` when the file has none. */
const readHolder = (file: string): number | undefined => {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Creates the lock file with the process ID in it, or returns `false` when it exists.
 *
 * The ID is written to a file of this process first and then linked, so that no process can see
 * a lock file without an ID.
 */
const tryCreate = (file: string): boolean => {
  const own = `${file}.${process.pid}.tmp`;
  writeFileSync(own, `${process.pid}\n`, { flag: "w", mode: 0o600 });
  try {
    linkSync(own, file);
    return true;
  } catch (error) {
    if (hasCode(error, "EEXIST")) {
      return false;
    }
    throw error;
  } finally {
    rmSync(own, { force: true });
  }
};

/**
 * Removes a lock that a stopped process left, if it is still that lock.
 *
 * The lock is moved aside first, so that only one process removes it. When another process
 * replaced it in the meantime, the moved lock is put back.
 */
const removeStale = (file: string, stalePid: number): void => {
  const aside = `${file}.${process.pid}.stale`;
  try {
    renameSync(file, aside);
  } catch (error) {
    // Another process removed it first.
    if (hasCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  if (readHolder(aside) !== stalePid) {
    try {
      linkSync(aside, file);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw error;
      }
    }
  }
  rmSync(aside, { force: true });
};

/**
 * Takes the lock of a run, so that two processes do not ask the same wait step or run its
 * scripts at the same time.
 *
 * A lock that a stopped process left is taken over. The lock is released when the process
 * exits.
 *
 * @throws RunLockedError When a running process holds the lock, or when the lock cannot be read.
 */
export const acquireRunLock = (directory: string, workflowId: string): RunLock => {
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const file = join(directory, `${encodeURIComponent(workflowId)}.lock`);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (tryCreate(file)) {
      const release = (): void => {
        process.off("exit", release);
        if (readHolder(file) === process.pid) {
          rmSync(file, { force: true });
        }
      };
      process.once("exit", release);
      return { release };
    }
    const pid = readHolder(file);
    // A lock that cannot be read is kept, because its process may still follow the run.
    if (pid === undefined || isAlive(pid)) {
      throw new RunLockedError(workflowId, pid, file);
    }
    removeStale(file, pid);
  }
  throw new Error(`Failed to lock ${workflowId}`);
};
