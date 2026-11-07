import { validateIntermediate } from "@aitw/core";
import type { IntermediateStep } from "@aitw/core";
import { ApplicationFailure, proxyActivities } from "@temporalio/workflow";

import type { Activities } from "../activities/index.js";

/**
 * Extra time that lets a script runner report its own timeout before the activity times out.
 *
 * Keep it longer than the time a script runner needs to stop a script, such as `killGraceMs`
 * in `@aitw/adapter-script-local`.
 */
const activityTimeoutGraceMs = 10_000;

/** Result of {@link interpreterWorkflow}. */
export interface WorkflowResult {
  /** IDs of the executed steps, in execution order. */
  executedSteps: string[];
}

/**
 * Executes a workflow in the intermediate representation.
 *
 * The input is validated again because it can be supplied without the definition package.
 */
export const interpreterWorkflow = async (input: unknown): Promise<WorkflowResult> => {
  const validation = validateIntermediate(input);
  if (!validation.ok) {
    throw ApplicationFailure.nonRetryable(
      "Invalid intermediate representation",
      "InvalidIntermediate",
      validation.errors,
    );
  }

  const { start, steps } = validation.intermediate;
  const executedSteps: string[] = [];

  let id: string | null = start;
  while (id !== null) {
    const step: IntermediateStep | undefined = steps[id];
    if (step === undefined) {
      throw ApplicationFailure.nonRetryable(`Unknown step: ${id}`, "InvalidIntermediate");
    }

    const { executeScriptStep } = proxyActivities<Activities>({
      retry: { maximumAttempts: 1 },
      startToCloseTimeout: step.timeoutMs + activityTimeoutGraceMs,
    });
    await executeScriptStep({ input: {}, run: step.run, timeoutMs: step.timeoutMs });
    executedSteps.push(id);

    id = step.next.type === "step" ? step.next.step : null;
  }

  return { executedSteps };
};
