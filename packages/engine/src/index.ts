export const packageName = "@aitw/engine";

export { createActivities } from "./activities/index.js";
export type { Activities, ActivityDependencies } from "./activities/index.js";
export { runWorkflow, workflowsPath } from "./run.js";
export type { RunWorkflowOptions } from "./run.js";
export type { WorkflowResult } from "./workflows/index.js";
