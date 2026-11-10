import {
  AiTimeoutError,
  conditionReferences,
  embedValue,
  evaluateCondition,
  evaluateExpression,
  parseCondition,
  ScriptTimeoutError,
} from "@aitw/core";
import type {
  AiRequest,
  AiResult,
  AiRunner,
  AiRunOptions,
  EnvironmentReader,
  EventLog,
  ScriptOutput,
  ScriptRequest,
  ScriptResult,
  ScriptRunner,
  ScriptRunOptions,
  StepOutcome,
  Transition,
  WorkflowEvent,
} from "@aitw/core";
import { ApplicationFailure, Context } from "@temporalio/activity";

import { jsonBytes, maxValueBytes } from "../limits.js";

/** Adapters and settings that the activities use. */
export interface ActivityDependencies {
  scriptRunner: ScriptRunner;
  /** Runs AI steps. A step fails when it is omitted, such as in a Worker only for cancelling. */
  aiRunner?: AiRunner | undefined;
  /** Reads the environment for conditions. A condition that reads `env` fails without it. */
  readEnvironment?: EnvironmentReader | undefined;
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
export interface ScriptStepRequest extends Omit<ScriptRequest, "env"> {
  /** ID of the step in the workflow definition. */
  step: string;
  /** Environment variables of the step, keyed by name. Values may contain expressions. */
  stepEnv?: Readonly<Record<string, string>> | undefined;
  /** Environment variables of the workflow, after their expressions are evaluated. */
  workflowEnv?: Readonly<Record<string, string>> | undefined;
  /** Expressions of the values that the step publishes, keyed by name. */
  outputs: Readonly<Record<string, string>>;
  /**
   * Values of earlier steps and of the workflow input that `run` and `outputs` reference, as
   * `steps` and `workflow` entries.
   */
  references: Readonly<Record<string, unknown>>;
}

/** The branches of a step. The first whose condition holds is taken. */
export type Branches = Extract<Transition, { type: "branch" }>["branches"];

/** Input of {@link Activities.executeBranchingScriptStep}. */
export interface BranchingScriptStepRequest extends ScriptStepRequest {
  branches: Branches;
}

/** Result of a step with branches. */
export interface BranchedStepResult {
  outputs: StepOutput;
  /** ID of the step to go to, or `null` to finish the workflow. */
  next: string | null;
}

/** Input of {@link Activities.chooseBranch}. */
export interface ChooseBranchRequest {
  branches: Branches;
  dotenv?: string | undefined;
  workflowEnv?: Readonly<Record<string, string>> | undefined;
  /** Values that the conditions can read: `outputs`, `result`, `steps`, and `workflow`. */
  values: Readonly<Record<string, unknown>>;
}

/** Input of {@link Activities.executeAiStep}. */
export interface AiStepRequest extends Omit<AiRequest, "env"> {
  /** ID of the step in the workflow definition. */
  step: string;
  /** Environment variables of the step, keyed by name. Values may contain expressions. */
  stepEnv?: Readonly<Record<string, string>> | undefined;
  /** Environment variables of the workflow, after their expressions are evaluated. */
  workflowEnv?: Readonly<Record<string, string>> | undefined;
  /** Evaluated input values of the step. */
  inputs: Readonly<Record<string, unknown>>;
  /** Expressions of the values that the step publishes, keyed by name. */
  outputs: Readonly<Record<string, string>>;
  /** Values of earlier steps and of the workflow input that the step references. */
  references: Readonly<Record<string, unknown>>;
  /** Branches of the step, when it has them. */
  branches?: Branches | undefined;
}

/** Result of {@link Activities.executeAiStep}. */
export interface AiStepResult {
  outputs: StepOutput;
  /** Session that a later run of the step can continue. */
  sessionId?: string | undefined;
  /** ID of the step to go to, or `null` to finish, when the step has branches. */
  next?: string | null | undefined;
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

/**
 * Evaluates the environment variables of a step, and combines them with those of the workflow.
 *
 * Values are embedded as text, so that `null` becomes an empty string and objects become JSON.
 */
const evaluateEnv = (
  stepEnv: Readonly<Record<string, string>> | undefined,
  workflowEnv: Readonly<Record<string, string>> | undefined,
  values: Readonly<Record<string, unknown>>,
): { ok: true; value: Record<string, string> } | { ok: false; error: ApplicationFailure } => {
  // Variables of the step replace those of the workflow.
  const env: Record<string, string> = { ...workflowEnv };
  for (const [name, expression] of Object.entries(stepEnv ?? {})) {
    const evaluated = evaluateExpression(expression, values);
    if (!evaluated.ok) {
      return { error: invalidExpression(`env.${name}`, evaluated.message), ok: false };
    }
    env[name] = embedValue(evaluated.value);
  }
  return { ok: true, value: env };
};

/** Evaluates the declared output values from the result of a step. */
const evaluateOutput = (
  expressions: Readonly<Record<string, string>>,
  context: Readonly<Record<string, unknown>>,
  result: Readonly<Record<string, unknown>>,
): StepOutput => {
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

/** Returns the step that the first branch that holds goes to, or `null` to finish. */
const chooseNext = (
  branches: Branches,
  values: Readonly<Record<string, unknown>>,
): string | null => {
  for (const [index, { if: condition, to }] of branches.entries()) {
    if (condition !== undefined) {
      const parsed = parseCondition(condition);
      const evaluated = parsed.ok ? evaluateCondition(parsed.condition, values) : parsed;
      if (!evaluated.ok) {
        throw ApplicationFailure.nonRetryable(
          `next[${index}].if: ${evaluated.message}`,
          "InvalidCondition",
        );
      }
      if (!evaluated.value) {
        continue;
      }
    }
    return to.type === "step" ? to.step : null;
  }
  // Validation requires a last branch without a condition.
  throw ApplicationFailure.nonRetryable("No branch can be taken", "InvalidCondition");
};

const readsEnvironment = (branches: Branches): boolean =>
  branches.some(({ if: condition }) => {
    const parsed = condition === undefined ? undefined : parseCondition(condition);
    return (
      parsed?.ok === true && conditionReferences(parsed.condition).some(([root]) => root === "env")
    );
  });

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

const runAi = async (
  aiRunner: AiRunner | undefined,
  request: AiRequest,
  options: AiRunOptions,
): Promise<AiResult> => {
  if (aiRunner === undefined) {
    throw ApplicationFailure.nonRetryable("This Worker cannot run AI steps", "AiRunnerUnavailable");
  }
  return aiRunner.run(request, options).catch((error: unknown) => {
    if (error instanceof AiTimeoutError) {
      throw ApplicationFailure.nonRetryable(error.message, "AiTimedOut", {
        timeoutMs: error.timeoutMs,
      });
    }
    throw error;
  });
};

/** Creates the activities that a Worker registers. */
export const createActivities = ({
  aiRunner,
  eventLog = discardEvents,
  heartbeatIntervalMs = 5000,
  readEnvironment,
  scriptRunner,
}: ActivityDependencies) => {
  /**
   * Reports the start and the end of a step around its work, and keeps the activity alive.
   *
   * @param body Does the work, and receives a function that reports its output.
   */
  const trackStep = async <Result>(
    step: string,
    started: { provider?: string; run?: string },
    body: (onOutput: (output: ScriptOutput) => void) => Promise<Result>,
  ): Promise<Result> => {
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
    // Output that arrives after the step settles would appear after the end of the step.
    let settled = false;
    emit({ ...started, step, type: "stepStarted" });
    const heartbeat = setInterval(() => context.heartbeat(), heartbeatIntervalMs);

    try {
      const result = await body((output) => {
        if (!settled) {
          emit({ ...output, step, type: "stepOutput" });
        }
      });
      settled = true;
      emit({
        durationMs: Math.round(performance.now() - startedAt),
        outcome: "succeeded",
        step,
        type: "stepFinished",
      });
      return result;
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
  };

  /**
   * Chooses where a step goes next.
   *
   * The environment is read only for a condition that needs it, so that a file that cannot be
   * read fails only the steps that depend on it.
   */
  const choose = (
    branches: Branches,
    values: Readonly<Record<string, unknown>>,
    dotenv: string | undefined,
    env: Readonly<Record<string, string>>,
  ): string | null => {
    if (!readsEnvironment(branches)) {
      return chooseNext(branches, values);
    }
    if (readEnvironment === undefined) {
      throw ApplicationFailure.nonRetryable(
        "This Worker cannot read the environment",
        "EnvironmentUnavailable",
      );
    }
    let inherited: Readonly<Record<string, string | undefined>>;
    try {
      inherited = readEnvironment(dotenv);
    } catch (error) {
      throw ApplicationFailure.nonRetryable(
        error instanceof Error ? error.message : String(error),
        "EnvironmentUnreadable",
      );
    }
    return chooseNext(branches, { ...values, env: { ...inherited, ...env } });
  };

  /** Runs a script step, and chooses where it goes next when it has branches. */
  const runScriptStep = async ({
    branches,
    dotenv,
    inputs,
    outputs: outputExpressions,
    references,
    run: runTemplate,
    step,
    stepEnv,
    timeoutMs,
    workflowEnv,
  }: ScriptStepRequest & { branches?: Branches }): Promise<BranchedStepResult> => {
    // The step inputs are added last, so that references cannot replace them.
    const values = { ...references, inputs };
    const env = evaluateEnv(stepEnv, workflowEnv, values);
    const expanded = evaluateExpression(runTemplate, values);
    const run = expanded.ok ? embedValue(expanded.value) : runTemplate;

    return trackStep(step, { run }, async (onOutput) => {
      if (!env.ok) {
        throw env.error;
      }
      if (!expanded.ok) {
        throw invalidExpression("run", expanded.message);
      }
      const { exitCode, stderr, stdout } = await runScript(
        scriptRunner,
        {
          // A step without variables sends none, as before they existed.
          ...(dotenv === undefined ? {} : { dotenv }),
          ...(Object.keys(env.value).length > 0 ? { env: env.value } : {}),
          inputs,
          run,
          timeoutMs,
        },
        { onOutput, signal: Context.current().cancellationSignal },
      );
      const result = {
        exitCode,
        stderr: trimTrailingNewline(stderr),
        stdout: trimTrailingNewline(stdout),
      };
      const outputs = evaluateOutput(outputExpressions, values, result);
      return {
        next:
          branches === undefined
            ? null
            : choose(branches, { ...values, outputs, result }, dotenv, env.value),
        outputs,
      };
    });
  };

  return {
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
    executeScriptStep: async (request: ScriptStepRequest): Promise<StepOutput> =>
      (await runScriptStep(request)).outputs,
    /** Runs a script step with branches, and returns the step that it goes to. */
    executeBranchingScriptStep: async (
      request: BranchingScriptStepRequest,
    ): Promise<BranchedStepResult> => runScriptStep(request),
    /** Chooses where a step goes next, for a step that does not run in an activity. */
    chooseBranch: async ({
      branches,
      dotenv,
      values,
      workflowEnv = {},
    }: ChooseBranchRequest): Promise<string | null> =>
      choose(branches, values, dotenv, workflowEnv),
    /**
     * Runs an AI step. It is not retried, because it may have changed files before it failed.
     *
     * Only the declared output values are returned, because the workflow history stores the result.
     */
    executeAiStep: async ({
      branches,
      dotenv,
      inputs,
      model,
      options,
      outputs: outputExpressions,
      prompt: promptTemplate,
      provider,
      references,
      schema,
      sessionId,
      step,
      stepEnv,
      timeoutMs,
      workflowEnv,
    }: AiStepRequest): Promise<AiStepResult> => {
      // The step inputs are added last, so that references cannot replace them.
      const values = { ...references, inputs };

      return trackStep(step, { provider }, async (onOutput) => {
        const env = evaluateEnv(stepEnv, workflowEnv, values);
        if (!env.ok) {
          throw env.error;
        }
        const prompt = evaluateExpression(promptTemplate, values);
        if (!prompt.ok) {
          throw invalidExpression("prompt", prompt.message);
        }
        const result = await runAi(
          aiRunner,
          {
            ...(dotenv === undefined ? {} : { dotenv }),
            ...(Object.keys(env.value).length > 0 ? { env: env.value } : {}),
            ...(model === undefined ? {} : { model }),
            ...(schema === undefined ? {} : { schema }),
            ...(sessionId === undefined ? {} : { sessionId }),
            options,
            prompt: embedValue(prompt.value),
            provider,
            timeoutMs,
          },
          {
            onProgress: (text) => onOutput({ stream: "stdout", text }),
            signal: Context.current().cancellationSignal,
          },
        );
        const aiResult = { data: result.data };
        const stepOutputs = evaluateOutput(outputExpressions, values, aiResult);
        return {
          outputs: stepOutputs,
          ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
          ...(branches === undefined
            ? {}
            : {
                next: choose(
                  branches,
                  { ...values, outputs: stepOutputs, result: aiResult },
                  dotenv,
                  env.value,
                ),
              }),
        };
      });
    },
  };
};

/** Activities registered by a Worker. */
export type Activities = ReturnType<typeof createActivities>;
