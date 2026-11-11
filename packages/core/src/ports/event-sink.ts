import { z } from "zod";

/** How a step ended. */
export type StepOutcome = "succeeded" | "failed" | "cancelled";

/** An event that reports the progress of a workflow run. */
export type WorkflowEvent =
  | {
      type: "stepStarted";
      step: string;
      /** Command line of a script step. Other steps have none. */
      run?: string | undefined;
      /** Provider of an AI step. Other steps have none. */
      provider?: string | undefined;
      /**
       * What a wait step waits for, from the `message` option of its method, such as to list
       * the runs that wait.
       */
      message?: string | undefined;
    }
  | {
      type: "stepOutput";
      step: string;
      stream: "stdout" | "stderr";
      text: string;
    }
  | {
      type: "stepFinished";
      step: string;
      outcome: StepOutcome;
      durationMs: number;
      /** Reason of a failure, absent when the step succeeded. */
      message?: string | undefined;
      /** Whether the workflow goes on after the step failed, as `continueOnError` asks. */
      continued?: boolean | undefined;
    };

/**
 * Port that receives progress events of workflow runs.
 *
 * Events are delivered as they happen and are not stored in the workflow history.
 */
export interface EventSink {
  emit: (event: WorkflowEvent) => void;
}

const stepEventBase = { step: z.string() };

/** Schema of {@link WorkflowEvent}, for events that come from outside the process. */
export const workflowEventSchema: z.ZodType<WorkflowEvent> = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("stepStarted"),
    ...stepEventBase,
    run: z.string().optional(),
    provider: z.string().optional(),
    message: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("stepOutput"),
    ...stepEventBase,
    stream: z.enum(["stdout", "stderr"]),
    text: z.string(),
  }),
  z.strictObject({
    type: z.literal("stepFinished"),
    ...stepEventBase,
    outcome: z.enum(["succeeded", "failed", "cancelled"]),
    durationMs: z.number(),
    message: z.string().optional(),
    continued: z.boolean().optional(),
  }),
]);
