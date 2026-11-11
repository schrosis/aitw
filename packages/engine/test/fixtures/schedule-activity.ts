import { proxyActivities } from "@temporalio/workflow";

/**
 * A workflow of someone who can reach the Temporal Server but does not hold the key.
 *
 * It schedules an activity on the task queue of another Worker.
 */
export const scheduleActivity = async (taskQueue: string, request: unknown): Promise<unknown> => {
  const { executeScriptStep } = proxyActivities<{
    executeScriptStep: (request: unknown) => Promise<unknown>;
  }>({ retry: { maximumAttempts: 1 }, scheduleToCloseTimeout: "20 seconds", taskQueue });
  return executeScriptStep(request);
};
