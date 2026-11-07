import type { ScriptRequest, ScriptResult, ScriptRunner } from "@aitw/core";
import { ApplicationFailure } from "@temporalio/activity";

/** Adapters that the activities use. */
export interface ActivityDependencies {
  scriptRunner: ScriptRunner;
}

/** Creates the activities that a Worker registers. */
export const createActivities = ({ scriptRunner }: ActivityDependencies) => ({
  /** Runs a script step and fails without retrying when the script exits with an error. */
  executeScriptStep: async (request: ScriptRequest): Promise<ScriptResult> => {
    const result = await scriptRunner.run(request);
    if (result.exitCode !== 0) {
      throw ApplicationFailure.nonRetryable(
        `Script exited with code ${result.exitCode}`,
        "ScriptFailed",
        result,
      );
    }
    return result;
  },
});

/** Activities registered by a Worker. */
export type Activities = ReturnType<typeof createActivities>;
