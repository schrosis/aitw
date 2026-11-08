import { evaluateExpression, resolveWorkflowInput, validateIntermediate } from "@aitw/core";
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

/**
 * Evaluates the input values of a step from the workflow input and the outputs of the steps
 * that ran before it.
 */
const evaluateInput = (
  id: string,
  expressions: Readonly<Record<string, string>>,
  workflowInput: Readonly<WorkflowInput>,
  outputs: Readonly<Record<string, StepOutput>>,
): Record<string, unknown> => {
  const steps = Object.fromEntries(
    Object.entries(outputs).map(([stepId, output]) => [stepId, { output }]),
  );
  const context = { steps, workflow: { input: workflowInput } };
  const input: Record<string, unknown> = {};
  for (const [name, expression] of Object.entries(expressions)) {
    const evaluated = evaluateExpression(expression, context);
    if (!evaluated.ok) {
      throw ApplicationFailure.nonRetryable(
        `steps.${id}.input.${name}: ${evaluated.message}`,
        "InvalidExpression",
      );
    }
    input[name] = evaluated.value;
  }

  // Input can combine the output of several steps, so it is limited separately.
  const bytes = jsonBytes(input);
  if (bytes > maxValueBytes) {
    throw ApplicationFailure.nonRetryable(
      `steps.${id}.input is ${bytes} bytes, which exceeds the limit of ${maxValueBytes} bytes`,
      "InputTooLarge",
    );
  }
  return input;
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

  const resolved = resolveWorkflowInput(validation.intermediate.input, input);
  if (!resolved.ok) {
    throw ApplicationFailure.nonRetryable(
      resolved.errors
        .map(({ message, path }) => `${["workflow.input", ...path].join(".")}: ${message}`)
        .join("\n"),
      "InvalidInput",
      resolved.errors,
    );
  }
  const bytes = jsonBytes(resolved.input);
  if (bytes > maxValueBytes) {
    throw ApplicationFailure.nonRetryable(
      `workflow.input is ${bytes} bytes, which exceeds the limit of ${maxValueBytes} bytes`,
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
    outputs[id] = await executeScriptStep({
      input: evaluateInput(id, step.input, resolved.input, outputs),
      output: step.output,
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
