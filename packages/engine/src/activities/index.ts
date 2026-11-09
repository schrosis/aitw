import { embedValue, evaluateExpression, ScriptTimeoutError } from "@aitw/core";
import type {
  EventLog,
  ScriptRequest,
  ScriptResult,
  ScriptRunner,
  ScriptRunOptions,
  StepOutcome,
  WorkflowEvent,
} from "@aitw/core";
import { ApplicationFailure, Context } from "@temporalio/activity";

import { jsonBytes, maxValueBytes } from "../limits.js";

/** Adapters and settings that the activities use. */
export interface ActivityDependencies {
  scriptRunner: ScriptRunner;
  /** Stores progress events, keyed by the workflow ID. Events are discarded when it is omitted. */
  eventLog?: EventLog | undefined;
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
  /** Expressions of the values that the step publishes, keyed by name. */
  outputs: Readonly<Record<string, string>>;
  /**
   * Values of earlier steps and of the workflow input that `run` and `outputs` reference, as
   * `steps` and `workflow` entries.
   */
  references: Readonly<Record<string, unknown>>;
}

/** Values that a step publishes to later steps, keyed by name. */
export type StepOutput = Record<string, unknown>;

/** Removes one trailing newline, so that a single line of output becomes a plain value. */
const trimTrailingNewline = (text: string): string => {
  if (text.endsWith("\r\n")) {
    return text.slice(0, -2);
  }
  return text.endsWith("\n") ? text.slice(0, -1) : text;
};

const invalidExpression = (location: string, message: string): ApplicationFailure =>
  ApplicationFailure.nonRetryable(`${location}: ${message}`, "InvalidExpression");

/** Evaluates the declared output values from the result of a script. */
const evaluateOutput = (
  expressions: Readonly<Record<string, string>>,
  context: Readonly<Record<string, unknown>>,
  { exitCode, stderr, stdout }: ScriptResult,
): StepOutput => {
  const result = {
    exitCode,
    stderr: trimTrailingNewline(stderr),
    stdout: trimTrailingNewline(stdout),
  };
  const output: StepOutput = {};
  for (const [name, expression] of Object.entries(expressions)) {
    const evaluated = evaluateExpression(expression, { ...context, result });
    if (!evaluated.ok) {
      throw invalidExpression(`outputs.${name}`, evaluated.message);
    }
    output[name] = evaluated.value;
  }

  const bytes = jsonBytes(output);
  if (bytes > maxValueBytes) {
    throw ApplicationFailure.nonRetryable(
      `Output is ${bytes} bytes, which exceeds the limit of ${maxValueBytes} bytes`,
      "OutputTooLarge",
    );
  }
  return output;
};

const discardEvents: EventLog = {
  append: () => {},
  read: async () => ({ cursor: "", events: [] }),
};

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
): Promise<ScriptResult> => {
  const result = await scriptRunner.run(request, options).catch((error: unknown) => {
    if (error instanceof ScriptTimeoutError) {
      throw ApplicationFailure.nonRetryable(error.message, "ScriptTimedOut", {
        timeoutMs: error.timeoutMs,
      });
    }
    throw error;
  });

  const { exitCode, signal: stopSignal } = result;
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
  return result;
};

/** Creates the activities that a Worker registers. */
export const createActivities = ({
  eventLog = discardEvents,
  heartbeatIntervalMs = 5000,
  scriptRunner,
}: ActivityDependencies) => ({
  /**
   * Stores a progress event of the workflow, such as the start of a wait step.
   *
   * The workflow cannot write the log itself, and storing events from the Worker keeps them in
   * the order of the steps.
   */
  recordEvent: async (event: WorkflowEvent): Promise<void> => {
    const context = Context.current();
    try {
      const runId = context.info.workflowExecution?.workflowId;
      if (runId !== undefined) {
        eventLog.append(runId, event);
      }
    } catch (error) {
      // Progress is only observed, so a failing log must not stop the workflow.
      context.log.warn("Failed to record a progress event", { error, step: event.step });
    }
  },
  /**
   * Runs a script step and fails without retrying when the script does not exit with zero.
   *
   * The `${{ }}` references in `run` are expanded as plain text. Only the declared output
   * values are returned, because the workflow history stores the result.
   */
  executeScriptStep: async ({
    inputs,
    outputs: outputExpressions,
    references,
    run: runTemplate,
    step,
    timeoutMs,
  }: ScriptStepRequest): Promise<StepOutput> => {
    const context = Context.current();
    // Progress is only observed, so a failing log must not change the result of the step.
    const emit = (event: WorkflowEvent): void => {
      try {
        // Events are keyed by the workflow, so an activity outside a workflow stores none.
        const runId = context.info.workflowExecution?.workflowId;
        if (runId !== undefined) {
          eventLog.append(runId, event);
        }
      } catch (error) {
        context.log.warn("Failed to emit a progress event", { error, step });
      }
    };
    // A monotonic clock keeps durations correct when the system clock is adjusted.
    const startedAt = performance.now();
    // Output that arrives after the script settles would appear after the end of the step.
    let settled = false;
    // The step inputs are added last, so that references cannot replace them.
    const values = { ...references, inputs };
    const expanded = evaluateExpression(runTemplate, values);
    const run = expanded.ok ? embedValue(expanded.value) : runTemplate;
    emit({ run, step, type: "stepStarted" });
    const heartbeat = setInterval(() => context.heartbeat(), heartbeatIntervalMs);

    try {
      if (!expanded.ok) {
        throw invalidExpression("run", expanded.message);
      }
      const result = await runScript(
        scriptRunner,
        { inputs, run, timeoutMs },
        {
          onOutput: (output) => {
            if (!settled) {
              emit({ ...output, step, type: "stepOutput" });
            }
          },
          signal: context.cancellationSignal,
        },
      );
      settled = true;
      const output = evaluateOutput(outputExpressions, values, result);
      emit({
        durationMs: Math.round(performance.now() - startedAt),
        outcome: "succeeded",
        step,
        type: "stepFinished",
      });
      return output;
    } catch (error) {
      settled = true;
      emit({
        durationMs: Math.round(performance.now() - startedAt),
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
