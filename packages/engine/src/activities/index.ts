import { ScriptTimeoutError } from "@aitw/core";
import type { EventSink, ScriptRequest, ScriptRunner } from "@aitw/core";
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

const runScript = async (
  scriptRunner: ScriptRunner,
  request: ScriptRequest,
  signal: AbortSignal,
): Promise<void> => {
  const { exitCode, signal: stopSignal } = await scriptRunner
    .run(request, signal)
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
    const heartbeat = setInterval(() => context.heartbeat(), heartbeatIntervalMs);
    const startedAt = Date.now();
    eventSink.emit({ run: request.run, step, type: "stepStarted" });

    try {
      await runScript(scriptRunner, request, context.cancellationSignal);
      eventSink.emit({
        durationMs: Date.now() - startedAt,
        outcome: "succeeded",
        step,
        type: "stepFinished",
      });
    } catch (error) {
      eventSink.emit({
        durationMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
        outcome: context.cancellationSignal.aborted ? "cancelled" : "failed",
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
