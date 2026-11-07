import { ScriptTimeoutError } from "@aitw/core";
import type {
  EventSink,
  ScriptRequest,
  ScriptRunner,
  ScriptRunOptions,
  StepOutcome,
  WorkflowEvent,
} from "@aitw/core";
import { ApplicationFailure, Context } from "@temporalio/activity";

/** Adapters and settings that the activities use. */
export interface ActivityDependencies {
  scriptRunner: ScriptRunner;
  /** Receives progress events. Events are discarded when it is omitted. */
  eventSink?: EventSink | undefined;
  /**
   * Interval of activity heartbeats, in milliseconds.
   *
   * Temporal delivers cancellation to an activity only through heartbeats. Keep it shorter
   * than the heartbeat timeout of the interpreter workflow.
   */
  heartbeatIntervalMs?: number;
}

/** Input of {@link Activities.executeScriptStep}. */
export interface ScriptStepRequest extends ScriptRequest {
  /** ID of the step in the workflow definition. */
  step: string;
}

const discardEvents: EventSink = { emit: () => {} };

/** Reasons of an aborted activity that mean the step itself failed. */
const failedAbortReasons = new Set(["TIMED_OUT", "HEARTBEAT_DETAILS_CONVERSION_FAILED"]);

/**
 * Returns how a step that threw ended.
 *
 * Temporal aborts the cancellation signal for several reasons. A timeout means the step failed.
 * The other reasons, such as a cancelled workflow or a Worker that stops after the cancellation,
 * mean the step was stopped from outside.
 */
const failureOutcome = (signal: AbortSignal): StepOutcome => {
  if (!signal.aborted) {
    return "failed";
  }
  const reason: unknown = signal.reason;
  return reason instanceof Error && failedAbortReasons.has(reason.message) ? "failed" : "cancelled";
};

const runScript = async (
  scriptRunner: ScriptRunner,
  request: ScriptRequest,
  options: ScriptRunOptions,
): Promise<void> => {
  const { exitCode, signal: stopSignal } = await scriptRunner
    .run(request, options)
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
        ? `Script was stopped by ${stopSignal ?? "an unknown signal"}`
        : `Script exited with code ${exitCode}`;
    throw ApplicationFailure.nonRetryable(message, "ScriptFailed", {
      exitCode,
      signal: stopSignal,
    });
  }
};

/** Creates the activities that a Worker registers. */
export const createActivities = ({
  eventSink = discardEvents,
  heartbeatIntervalMs = 5000,
  scriptRunner,
}: ActivityDependencies) => ({
  /**
   * Runs a script step and fails without retrying when the script does not exit with zero.
   *
   * The script output is not returned because the workflow history stores activity results.
   * Declared output values are evaluated here in a later change.
   */
  executeScriptStep: async ({ step, ...request }: ScriptStepRequest): Promise<void> => {
    const context = Context.current();
    // Progress is only observed, so a failing sink must not change the result of the step.
    const emit = (event: WorkflowEvent): void => {
      try {
        eventSink.emit(event);
      } catch (error) {
        context.log.warn("Failed to emit a progress event", { error, step });
      }
    };
    const startedAt = Date.now();
    // Output that arrives after the script settles would appear after the end of the step.
    let settled = false;
    emit({ run: request.run, step, type: "stepStarted" });
    const heartbeat = setInterval(() => context.heartbeat(), heartbeatIntervalMs);

    try {
      await runScript(scriptRunner, request, {
        onOutput: (output) => {
          if (!settled) {
            emit({ ...output, step, type: "stepOutput" });
          }
        },
        signal: context.cancellationSignal,
      });
      settled = true;
      emit({
        durationMs: Date.now() - startedAt,
        outcome: "succeeded",
        step,
        type: "stepFinished",
      });
    } catch (error) {
      settled = true;
      emit({
        durationMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
        outcome: failureOutcome(context.cancellationSignal),
        step,
        type: "stepFinished",
      });
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  },
});

/** Activities registered by a Worker. */
export type Activities = ReturnType<typeof createActivities>;
