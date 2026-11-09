import { createFileEventLog } from "@aitw/adapter-event-log-file";
import type { WorkflowEvent } from "@aitw/core";
import { isCompatibleMemo, listRunningWorkflows, workflowCodeVersionMemoKey } from "@aitw/engine";

import type { TerminalIO } from "@aitw/adapter-wait-terminal";
import { projectHash, projectLogDirectory, projectMemoKey, workflowMemoKey } from "./state.js";

/** A running workflow of the project, with where it is. */
export interface ProjectRun {
  workflowId: string;
  /** Name of the workflow, such as `release/notes`. */
  name: string;
  startTime: Date;
  /** Where the run is, such as `waiting at approve: Approve the change?`. */
  status: string;
  /** Whether this aitw can continue the run, which workflow code of its version started. */
  compatible: boolean;
  /** Workflow code version that started the run, or `undefined` when the run records none. */
  version: string | undefined;
}

/** Describes where a run is from its events. */
export const describeEvents = (events: readonly WorkflowEvent[]): string => {
  let current: Extract<WorkflowEvent, { type: "stepStarted" }> | undefined;
  for (const event of events) {
    if (event.type === "stepStarted") {
      current = event;
    } else if (event.type === "stepFinished" && event.step === current?.step) {
      current = undefined;
    }
  }
  if (current === undefined) {
    return events.length === 0 ? "starting" : "paused between steps";
  }
  if (current.run !== undefined) {
    return `running ${current.step}`;
  }
  return current.message === undefined
    ? `waiting at ${current.step}`
    : `waiting at ${current.step}: ${current.message}`;
};

/** Lists the running workflows of a project, most recent first. */
export const listProjectRuns = async (address: string, root: string): Promise<ProjectRun[]> => {
  const log = createFileEventLog({ directory: projectLogDirectory(root) });
  const runs = await listRunningWorkflows({
    address,
    memo: { [projectMemoKey]: projectHash(root) },
  });
  return Promise.all(
    runs.map(async ({ memo, startTime, workflowId }): Promise<ProjectRun> => {
      const name = memo[workflowMemoKey];
      const { events } = await log.read(workflowId).catch(() => ({ events: [] }));
      const version = memo[workflowCodeVersionMemoKey];
      return {
        compatible: isCompatibleMemo(memo),
        version: typeof version === "string" ? version : undefined,
        name: typeof name === "string" ? name : workflowId,
        startTime,
        status: describeEvents(events),
        workflowId,
      };
    }),
  );
};

/** Formats how long ago a time was, such as `5m ago`. */
export const formatAge = (time: Date, now = new Date()): string => {
  const seconds = Math.max(0, Math.floor((now.getTime() - time.getTime()) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
};

/**
 * Lets the user choose one of the runs in the terminal.
 *
 * @returns The chosen run, or `undefined` when the input ends.
 */
export const chooseRun = async (
  runs: readonly ProjectRun[],
  { readLine, write }: TerminalIO,
  signal: AbortSignal,
): Promise<ProjectRun | undefined> => {
  runs.forEach((run, index) => {
    const note = run.compatible ? "" : "  (started by another version of aitw)";
    write(`${index + 1}. ${run.name}  ${run.status}  started ${formatAge(run.startTime)}${note}\n`);
  });
  for (;;) {
    write(`Select a run (1-${runs.length}): `);
    const line = await readLine(signal);
    if (line === null) {
      return undefined;
    }
    const chosen = runs[Number(line.trim()) - 1];
    if (/^\d+$/u.test(line.trim()) && chosen !== undefined) {
      return chosen;
    }
    write(`Enter a number from 1 to ${runs.length}\n`);
  }
};
