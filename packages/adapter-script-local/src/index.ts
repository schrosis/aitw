import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import { parseEnv } from "node:util";

import { ScriptTimeoutError } from "@aitw/core";
import type { ScriptResult, ScriptRunner } from "@aitw/core";

/** Process groups of the scripts that run now, in every runner of this process. */
const runningGroups = new Set<number>();

/**
 * Stops the running scripts when the process exits.
 *
 * Scripts are in their own process groups, so they would outlive a process that exits without
 * stopping them, such as by process.exit() on a second interrupt.
 */
const killRunningGroups = (): void => {
  for (const pid of runningGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The process group has already exited.
    }
  }
};

let listening = false;

/** Registers {@link killRunningGroups} once, so that one listener serves every script. */
const listenForExit = (): void => {
  if (!listening) {
    process.on("exit", killRunningGroups);
    listening = true;
  }
};

type DotenvResult = { ok: true; values: NodeJS.Dict<string> } | { ok: false; message: string };

/**
 * Reads a dotenv file, relative to the working directory.
 *
 * The file is read each time a script runs, so its values never enter the workflow history. A
 * file that a symbolic link puts outside of the working directory is not read.
 */
const readDotenv = (cwd: string, path: string): DotenvResult => {
  const failure = (reason: string): DotenvResult => ({
    message: `Failed to read the dotenv file ${path}: ${reason}`,
    ok: false,
  });
  let file: string;
  try {
    const root = realpathSync(cwd);
    file = realpathSync(resolvePath(cwd, path));
    const inside = relative(root, file);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
      return failure("it is outside of the project root");
    }
    return { ok: true, values: parseEnv(readFileSync(file, "utf8")) };
  } catch (error) {
    // The reason is kept in the message, so that it is reported with the step.
    return failure(error instanceof Error ? error.message : String(error));
  }
};

/** Options of {@link createLocalScriptRunner}. */
export interface LocalScriptRunnerOptions {
  /** Working directory of the scripts. */
  cwd: string;
  /**
   * Time to wait after SIGTERM before sending SIGKILL, in milliseconds.
   *
   * Keep it shorter than the activity timeout grace in `@aitw/engine` so that a timeout is
   * reported by the runner.
   */
  killGraceMs?: number;
}

/**
 * Creates a script runner that runs scripts with `sh -e -c` on the local machine.
 *
 * Scripts run with the permissions and environment variables of the current process.
 * Stopping a script stops its whole process group. Processes that a script leaves running
 * are stopped when the script exits, and running scripts are stopped when the current process
 * exits.
 */
export const createLocalScriptRunner = ({
  cwd,
  killGraceMs = 5000,
}: LocalScriptRunnerOptions): ScriptRunner => ({
  run: (request, { onOutput, signal }) =>
    new Promise<ScriptResult>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }

      const dotenv: DotenvResult =
        request.dotenv === undefined ? { ok: true, values: {} } : readDotenv(cwd, request.dotenv);
      if (!dotenv.ok) {
        reject(new Error(dotenv.message));
        return;
      }

      const child = spawn("sh", ["-e", "-c", request.run], {
        cwd,
        // A new process group lets the runner stop child processes of the script.
        detached: true,
        // The definition sets variables over the inherited ones, which dotenv does not replace.
        env: { ...dotenv.values, ...process.env, ...request.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      if (child.pid !== undefined) {
        runningGroups.add(child.pid);
        listenForExit();
      }

      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
        onOutput?.({ stream: "stdout", text: chunk });
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
        onOutput?.({ stream: "stderr", text: chunk });
      });

      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let exit: { code: number | null; signalName: NodeJS.Signals | null } | undefined;

      const cleanUp = (): void => {
        settled = true;
        clearTimeout(timeoutTimer);
        // The kill timer is kept, because processes that ignore SIGTERM can outlive the script.
        signal.removeEventListener("abort", stop);
      };

      const fail = (error: unknown): void => {
        if (!settled) {
          cleanUp();
          reject(error);
        }
      };

      /** Sends a signal to the process group and reports unexpected errors as a failure. */
      const killGroup = (signalName: NodeJS.Signals): void => {
        if (child.pid === undefined) {
          return;
        }
        try {
          process.kill(-child.pid, signalName);
        } catch (error) {
          // The process group has already exited. macOS reports EPERM instead of ESRCH when
          // only exited processes that are not yet reaped remain in the group.
          const code = error instanceof Error && "code" in error ? error.code : undefined;
          if (code !== "ESRCH" && code !== "EPERM") {
            fail(error);
          }
        }
      };

      /** Stops the process group, escalating to SIGKILL after the grace period. */
      const stop = (): void => {
        killGroup("SIGTERM");
        // The timer must not keep the Worker process alive.
        killTimer ??= setTimeout(() => killGroup("SIGKILL"), killGraceMs).unref();
      };

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        stop();
      }, request.timeoutMs);
      signal.addEventListener("abort", stop, { once: true });

      child.on("error", fail);
      child.on("exit", (code, signalName) => {
        exit = { code, signalName };
        // Processes that the script left behind would keep running and hold its output open.
        stop();
      });
      child.on("close", () => {
        if (child.pid !== undefined) {
          runningGroups.delete(child.pid);
        }
        if (settled) {
          return;
        }
        cleanUp();
        if (timedOut) {
          reject(new ScriptTimeoutError(request.timeoutMs));
        } else if (signal.aborted) {
          reject(signal.reason);
        } else {
          resolve({
            exitCode: exit?.code ?? null,
            signal: exit?.signalName ?? null,
            stderr,
            stdout,
          });
        }
      });
    }),
});
