import {
  evaluateExpression,
  pickReferences,
  resolveWorkflowInput,
  validateIntermediate,
} from "@aitw/core";
import type { IntermediateStep, WorkflowInput } from "@aitw/core";
import { ApplicationFailure, proxyActivities } from "@temporalio/workflow";

import type { Activities, StepOutput } from "../activities/index.js";
import { jsonBytes, maxValueBytes } from "../limits.js";

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
  const input: Record<string, unknown> = {};
  for (const [name, expression] of Object.entries(expressions)) {
    const evaluated = evaluateExpression(expression, context);
    if (!evaluated.ok) {
      throw ApplicationFailure.nonRetryable(
        `steps.${id}.inputs.${name}: ${evaluated.message}`,
        "InvalidExpression",
      );
    }
    input[name] = evaluated.value;
  }

  return input;
};

/**
 * Builds the values that a step receives and checks their size.
 *
 * The step receives only the shared values that its `run` and `outputs` reference, so that the
 * history does not store every value of the workflow again for each step.
 */
const prepareStep = (id: string, step: IntermediateStep, context: SharedContext) => {
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
 * @param input Values of the workflow input, keyed by name. Defaults are applied here.
 */
export const aitw = async (intermediate: unknown, input: unknown = {}): Promise<WorkflowResult> => {
  const validation = validateIntermediate(intermediate);
  if (!validation.ok) {
    throw ApplicationFailure.nonRetryable(
      "Invalid intermediate representation",
      "InvalidIntermediate",
      validation.errors,
    );
  }

  const resolved = resolveWorkflowInput(validation.intermediate.inputs, input);
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

    const { executeScriptStep } = proxyActivities<Activities>({
      heartbeatTimeout: activityHeartbeatTimeoutMs,
      retry: { maximumAttempts: 1 },
      startToCloseTimeout: step.timeoutMs + activityTimeoutGraceMs,
    });
    const context: SharedContext = {
      steps: Object.fromEntries(
        Object.entries(outputs).map(([stepId, output]) => [stepId, { outputs: output }]),
      ),
      workflow: { inputs: resolved.inputs },
    };
    outputs[id] = await executeScriptStep({
      ...prepareStep(id, step, context),
      outputs: step.outputs,
      run: step.run,
      step: id,
      timeoutMs: step.timeoutMs,
    });
    executedSteps.push(id);

    id = step.next.type === "step" ? step.next.step : null;
  }

  // Outputs are not returned, because the result of every step together could exceed the
  // payload limit of Temporal.
  return { executedSteps };
};
