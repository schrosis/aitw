/** How a step ended. */
export type StepOutcome = "succeeded" | "failed" | "cancelled";

/** An event that reports the progress of a workflow run. */
export type WorkflowEvent =
  | {
      type: "stepStarted";
      step: string;
      /** Command line of a script step. */
      run: string;
    }
  | {
      type: "stepFinished";
      step: string;
      outcome: StepOutcome;
      durationMs: number;
      /** Reason of a failure, absent when the step succeeded. */
      message?: string;
    };

/**
 * Port that receives progress events of workflow runs.
 *
 * Events are delivered as they happen and are not stored in the workflow history.
 */
export interface EventSink {
  emit: (event: WorkflowEvent) => void;
}
