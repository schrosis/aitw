import { spawn } from "node:child_process";
import { constants } from "node:os";

import { ScriptTimeoutError } from "@aitw/core";
import type { ScriptResult, ScriptRunner } from "@aitw/core";

export const packageName = "@aitw/adapter-script-local";

/** Options of {@link createLocalScriptRunner}. */
export interface LocalScriptRunnerOptions {
  /** Working directory of the scripts. */
  cwd: string;
  /** Time to wait after SIGTERM before sending SIGKILL, in milliseconds. */
  killGraceMs?: number;
}

/**
 * Creates a script runner that runs scripts with `sh -e -c` on the local machine.
 *
 * Scripts run with the permissions and environment variables of the current process.
 * Stopping a script stops its whole process group.
 */
export const createLocalScriptRunner = ({
  cwd,
  killGraceMs = 5000,
}: LocalScriptRunnerOptions): ScriptRunner => ({
  run: (request, signal) =>
    new Promise<ScriptResult>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }

      const child = spawn("sh", ["-e", "-c", request.run], {
        cwd,
        // A new process group lets the runner stop child processes of the script.
        detached: true,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });

      const killGroup = (signalName: NodeJS.Signals): void => {
        if (child.pid === undefined) {
          return;
        }
        try {
          process.kill(-child.pid, signalName);
        } catch (error) {
          // The process group has already exited.
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
            throw error;
          }
        }
      };

      let killTimer: NodeJS.Timeout | undefined;
      const stop = (): void => {
        killGroup("SIGTERM");
        killTimer ??= setTimeout(() => killGroup("SIGKILL"), killGraceMs);
      };

      let timedOut = false;
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        stop();
      }, request.timeoutMs);
      signal.addEventListener("abort", stop, { once: true });

      const cleanUp = (): void => {
        clearTimeout(timeoutTimer);
        clearTimeout(killTimer);
        signal.removeEventListener("abort", stop);
      };

      child.on("error", (error) => {
        cleanUp();
        reject(error);
      });
      child.on("close", (code, signalName) => {
        cleanUp();
        if (timedOut) {
          reject(new ScriptTimeoutError(request.timeoutMs));
        } else if (signal.aborted) {
          reject(signal.reason);
        } else {
          // A shell reports a process killed by a signal as 128 plus the signal number.
          const exitCode = code ?? 128 + (signalName === null ? 0 : constants.signals[signalName]);
          resolve({ exitCode, stderr, stdout });
        }
      });
    }),
});
