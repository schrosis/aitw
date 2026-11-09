import {
  evaluateExpression,
  pickReferences,
  resolveWorkflowInput,
  validateIntermediate,
} from "@aitw/core";
import type {
  IntermediateStep,
  ScriptStep,
  StepOutcome,
  WaitStep,
  WorkflowInput,
} from "@aitw/core";
import {
  ApplicationFailure,
  CancellationScope,
  condition,
  defineQuery,
  defineUpdate,
  isCancellation,
  proxyActivities,
  proxyLocalActivities,
  setHandler,
} from "@temporalio/workflow";

import type { Activities, StepOutput } from "../activities/index.js";
import { jsonBytes, maxValueBytes } from "../limits.js";
import { answerUpdateName, waitingQueryName } from "../messages.js";
import type { Answer, WaitingStep } from "../messages.js";

const waitingQuery = defineQuery<WaitingStep | null>(waitingQueryName);

// Recording an event is quick, so a local activity keeps it out of the task queue.
const { recordEvent } = proxyLocalActivities<Activities>({
  retry: { maximumAttempts: 3 },
  startToCloseTimeout: "10 seconds",
});
const answerUpdate = defineUpdate<void, [Answer]>(answerUpdateName);

/**
 * Extra time that lets a script runner report its own timeout before the activity times out.
 *
 * Keep it longer than the time a script runner needs to stop a script, such as `killGraceMs`
 * in `@aitw/adapter-script-local`.
 */
const activityTimeoutGraceMs = 10_000;

/**
 * Time after which Temporal treats an activity without heartbeats as failed.
 *
 * Keep it longer than `heartbeatIntervalMs` of the activities.
 */
const activityHeartbeatTimeoutMs = 30_000;

/** Result of {@link aitw}. */
export interface WorkflowResult {
  /** IDs of the executed steps, in execution order. */
  executedSteps: string[];
}

/** Values that every field of a step can reference: earlier outputs and the workflow input. */
type SharedContext = Readonly<{
  steps: Readonly<Record<string, { outputs: StepOutput }>>;
  workflow: Readonly<{ inputs: Readonly<WorkflowInput> }>;
}>;

/** Top-level names of {@link SharedContext}. */
const sharedRoots: ReadonlySet<string> = new Set(["steps", "workflow"]);

/** Evaluates the input values of a step. */
const evaluateInput = (
  id: string,
  expressions: Readonly<Record<string, string>>,
  context: SharedContext,
): Record<string, unknown> => {
  const inputs: Record<string, unknown> = {};
  for (const [name, expression] of Object.entries(expressions)) {
    const evaluated = evaluateExpression(expression, context);
    if (!evaluated.ok) {
      throw ApplicationFailure.nonRetryable(
        `steps.${id}.inputs.${name}: ${evaluated.message}`,
        "InvalidExpression",
      );
    }
    inputs[name] = evaluated.value;
  }

  return inputs;
};

/**
 * Builds the values that a step receives and checks their size.
 *
 * The step receives only the shared values that its `run` and `outputs` reference, so that the
 * history does not store every value of the workflow again for each step.
 */
const prepareStep = (id: string, step: ScriptStep, context: SharedContext) => {
  const inputs = evaluateInput(id, step.inputs, context);
  const references = pickReferences(
    [step.run, ...Object.values(step.outputs)],
    context,
    sharedRoots,
  );

  // The values can combine the output of several steps, so they are limited separately.
  const bytes = jsonBytes({ inputs, references });
  if (bytes > maxValueBytes) {
    throw ApplicationFailure.nonRetryable(
      `The values for steps.${id} are ${bytes} bytes, which exceeds the limit of ${maxValueBytes} bytes`,
      "InputTooLarge",
    );
  }
  return { inputs, references };
};

const invalidExpression = (location: string, message: string): ApplicationFailure =>
  ApplicationFailure.nonRetryable(`${location}: ${message}`, "InvalidExpression");

/** Evaluates every string in a JSON value, such as the options in `with`. */
const evaluateStrings = (
  value: unknown,
  location: string,
  context: Readonly<Record<string, unknown>>,
): unknown => {
  if (typeof value === "string") {
    const evaluated = evaluateExpression(value, context);
    if (!evaluated.ok) {
      throw invalidExpression(location, evaluated.message);
    }
    return evaluated.value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => evaluateStrings(item, `${location}[${index}]`, context));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        evaluateStrings(item, `${location}.${key}`, context),
      ]),
    );
  }
  return value;
};

/** Evaluates the outputs of a wait step from the answers that it received. */
const evaluateWaitOutputs = (
  id: string,
  step: WaitStep,
  context: Readonly<Record<string, unknown>>,
): StepOutput => {
  const output: StepOutput = {};
  for (const [name, expression] of Object.entries(step.outputs)) {
    const evaluated = evaluateExpression(expression, context);
    if (!evaluated.ok) {
      throw invalidExpression(`steps.${id}.outputs.${name}`, evaluated.message);
    }
    output[name] = evaluated.value;
  }
  const bytes = jsonBytes(output);
  if (bytes > maxValueBytes) {
    throw ApplicationFailure.nonRetryable(
      `steps.${id}.outputs is ${bytes} bytes, which exceeds the limit of ${maxValueBytes} bytes`,
      "OutputTooLarge",
    );
  }
  return output;
};

/**
 * Executes a workflow in the intermediate representation.
 *
 * The export name is the workflow type that Temporal shows. Renaming it prevents Workers from
 * continuing runs that started with the previous name.
 *
 * Both arguments are validated again because they can be supplied without the CLI, such as
 * from the Temporal Web UI.
 *
 * @param intermediate The workflow in the intermediate representation.
 * @param inputs Values of the workflow input, keyed by name. Defaults are applied here.
 */
export const aitw = async (
  intermediate: unknown,
  inputs: unknown = {},
): Promise<WorkflowResult> => {
  const validation = validateIntermediate(intermediate);
  if (!validation.ok) {
    throw ApplicationFailure.nonRetryable(
      "Invalid intermediate representation",
      "InvalidIntermediate",
      validation.errors,
    );
  }

  const resolved = resolveWorkflowInput(validation.intermediate.inputs, inputs);
  if (!resolved.ok) {
    throw ApplicationFailure.nonRetryable(
      resolved.errors
        .map(({ message, path }) => `${["workflow.inputs", ...path].join(".")}: ${message}`)
        .join("\n"),
      "InvalidInput",
      resolved.errors,
    );
  }
  const bytes = jsonBytes(resolved.inputs);
  if (bytes > maxValueBytes) {
    throw ApplicationFailure.nonRetryable(
      `workflow.inputs is ${bytes} bytes, which exceeds the limit of ${maxValueBytes} bytes`,
      "InputTooLarge",
    );
  }

  // The wait step that waits for an answer, and the answer that it received.
  let waiting: WaitingStep | null = null;
  let answer: WorkflowInput | undefined;
  setHandler(waitingQuery, () => waiting);
  setHandler(
    answerUpdate,
    ({ values }) => {
      // The validator below has accepted these values, so the resolution succeeds.
      const accepted = waiting === null ? undefined : resolveWorkflowInput(waiting.answers, values);
      if (accepted?.ok === true) {
        answer = accepted.inputs;
        waiting = null;
      }
    },
    {
      // A rejected answer leaves no trace in the history, and the caller can answer again.
      validator: ({ step, values }) => {
        const current = waiting;
        if (current === null || current.step !== step) {
          throw new Error(`Step ${step} is not waiting for an answer`);
        }
        const accepted = resolveWorkflowInput(current.answers, values);
        if (!accepted.ok) {
          throw new Error(
            accepted.errors
              .map(({ message, path }) => `${[step, ...path].join(".")}: ${message}`)
              .join("\n"),
          );
        }
        const answerBytes = jsonBytes(accepted.inputs);
        if (answerBytes > maxValueBytes) {
          throw new Error(
            `The answer is ${answerBytes} bytes, which exceeds the limit of ${maxValueBytes} bytes`,
          );
        }
      },
    },
  );

  const { start, steps } = validation.intermediate;
  const executedSteps: string[] = [];
  // The latest output of each step. Loops will keep every visit (B10b).
  const outputs: Record<string, StepOutput> = {};

  let id: string | null = start;
  while (id !== null) {
    const step: IntermediateStep | undefined = steps[id];
    if (step === undefined) {
      throw ApplicationFailure.nonRetryable(`Unknown step: ${id}`, "InvalidIntermediate");
    }
    const context: SharedContext = {
      steps: Object.fromEntries(
        Object.entries(outputs).map(([stepId, output]) => [stepId, { outputs: output }]),
      ),
      workflow: { inputs: resolved.inputs },
    };

    if (step.type === "wait") {
      if (step.answers === undefined) {
        throw ApplicationFailure.nonRetryable(
          `steps.${id}: Wait method ${step.method} does not describe its answers, which is not supported yet`,
          "UnsupportedStep",
        );
      }
      const stepInputs = evaluateInput(id, step.inputs, context);
      const options = evaluateStrings(step.with, `steps.${id}.with`, {
        ...context,
        inputs: stepInputs,
      });
      // The start is stored before the step can be answered, so that it is shown first.
      await recordEvent({ step: id, type: "stepStarted" });
      // Workflow time is deterministic, so the duration is the same when the history replays.
      const startedAt = Date.now();
      const waitingStep = id;
      const finish = async (outcome: StepOutcome, message?: string): Promise<void> =>
        recordEvent({
          durationMs: Date.now() - startedAt,
          message,
          outcome,
          step: waitingStep,
          type: "stepFinished",
        });
      waiting = {
        answers: step.answers,
        method: step.method,
        options: typeof options === "object" && options !== null ? { ...options } : {},
        step: id,
      };
      answer = undefined;
      try {
        // Cancelling the workflow interrupts the wait.
        await condition(() => answer !== undefined);
        outputs[id] = evaluateWaitOutputs(id, step, {
          ...context,
          inputs: stepInputs,
          result: answer,
        });
      } catch (error) {
        waiting = null;
        if (isCancellation(error)) {
          await CancellationScope.nonCancellable(async () => finish("cancelled"));
        } else {
          await finish("failed", error instanceof Error ? error.message : String(error));
        }
        throw error;
      }
      await finish("succeeded");
    } else {
      const { executeScriptStep } = proxyActivities<Activities>({
        heartbeatTimeout: activityHeartbeatTimeoutMs,
        retry: { maximumAttempts: 1 },
        startToCloseTimeout: step.timeoutMs + activityTimeoutGraceMs,
      });
      outputs[id] = await executeScriptStep({
        ...prepareStep(id, step, context),
        outputs: step.outputs,
        run: step.run,
        step: id,
        timeoutMs: step.timeoutMs,
      });
    }
    executedSteps.push(id);

    id = step.next.type === "step" ? step.next.step : null;
  }

  // Outputs are not returned, because the result of every step together could exceed the
  // payload limit of Temporal.
  return { executedSteps };
};
