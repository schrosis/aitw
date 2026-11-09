import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/** A lock that keeps one process following a run. */
export interface RunLock {
  release: () => void;
}

/** Thrown when another process already follows a run. */
export class RunLockedError extends Error {
  readonly pid: number;

  constructor(workflowId: string, pid: number) {
    super(`Another process (${pid}) already follows ${workflowId}`);
    this.name = "RunLockedError";
    this.pid = pid;
  }
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means that the process exists but belongs to another user.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

const holder = (file: string): number | undefined => {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Takes the lock of a run, so that two processes do not ask the same wait step or run its
 * scripts at the same time.
 *
 * A lock that a stopped process left behind is taken over. The lock is released when the process
 * exits.
 *
 * @throws RunLockedError When a running process holds the lock.
 */
export const acquireRunLock = (directory: string, workflowId: string): RunLock => {
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const file = join(directory, `${encodeURIComponent(workflowId)}.lock`);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeSync(descriptor, `${process.pid}\n`);
      } finally {
        closeSync(descriptor);
      }
      const release = (): void => {
        process.off("exit", release);
        if (holder(file) === process.pid) {
          rmSync(file, { force: true });
        }
      };
      process.once("exit", release);
      return { release };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      const pid = holder(file);
      if (pid !== undefined && isAlive(pid)) {
        throw new RunLockedError(workflowId, pid);
      }
      rmSync(file, { force: true });
    }
  }
  throw new Error(`Failed to lock ${workflowId}`);
};
