import { ScriptTimeoutError } from "@aitw/core";
import type { ScriptRequest, ScriptRunner } from "@aitw/core";
import { ApplicationFailure, Context } from "@temporalio/activity";

/** Adapters and settings that the activities use. */
export interface ActivityDependencies {
  scriptRunner: ScriptRunner;
  /**
   * Interval of activity heartbeats, in milliseconds.
   *
   * Temporal delivers cancellation to an activity only through heartbeats. Keep it shorter
   * than the heartbeat timeout of the interpreter workflow.
   */
  heartbeatIntervalMs?: number;
}

/** Creates the activities that a Worker registers. */
export const createActivities = ({
  heartbeatIntervalMs = 5000,
  scriptRunner,
}: ActivityDependencies) => ({
  /**
   * Runs a script step and fails without retrying when the script does not exit with zero.
   *
   * The script output is not returned because the workflow history stores activity results.
   * Declared output values are evaluated here in a later change.
   */
  executeScriptStep: async (request: ScriptRequest): Promise<void> => {
    const context = Context.current();
    const heartbeat = setInterval(() => context.heartbeat(), heartbeatIntervalMs);

    try {
      const { exitCode, signal } = await scriptRunner
        .run(request, context.cancellationSignal)
        .catch((error: unknown) => {
          if (error instanceof ScriptTimeoutError) {
            throw ApplicationFailure.nonRetryable(error.message, "ScriptTimedOut", {
              timeoutMs: error.timeoutMs,
            });
          }
          throw error;
        });

      if (exitCode !== 0) {
        const message =
          exitCode === null
            ? `Script was stopped by ${signal ?? "an unknown signal"}`
            : `Script exited with code ${exitCode}`;
        throw ApplicationFailure.nonRetryable(message, "ScriptFailed", { exitCode, signal });
      }
    } finally {
      clearInterval(heartbeat);
    }
  },
});

/** Activities registered by a Worker. */
export type Activities = ReturnType<typeof createActivities>;
