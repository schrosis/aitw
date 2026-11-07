import type { ScriptRequest, ScriptRunner } from "@aitw/core";
import { ApplicationFailure, Context } from "@temporalio/activity";

/** Adapters that the activities use. */
export interface ActivityDependencies {
  scriptRunner: ScriptRunner;
}

/** Creates the activities that a Worker registers. */
export const createActivities = ({ scriptRunner }: ActivityDependencies) => ({
  /**
   * Runs a script step and fails without retrying when the script exits with an error.
   *
   * The script output is not returned because the workflow history stores activity results.
   * Declared output values are evaluated here in a later change.
   */
  executeScriptStep: async (request: ScriptRequest): Promise<void> => {
    const { exitCode } = await scriptRunner.run(request, Context.current().cancellationSignal);
    if (exitCode !== 0) {
      throw ApplicationFailure.nonRetryable(`Script exited with code ${exitCode}`, "ScriptFailed", {
        exitCode,
      });
    }
  },
});

/** Activities registered by a Worker. */
export type Activities = ReturnType<typeof createActivities>;
