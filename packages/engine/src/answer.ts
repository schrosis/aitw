import { setTimeout as sleep } from "node:timers/promises";

import { validateWithSchema } from "@aitw/core";
import type { PluginRegistry, WorkflowEvent } from "@aitw/core";
import { WorkflowUpdateFailedError } from "@temporalio/client";
import type { WorkflowHandle } from "@temporalio/client";

import { answerUpdateName, waitingQueryName } from "./messages.js";
import type { Answer, WaitingStep } from "./messages.js";

/**
 * Intervals of checking whether the workflow waits for an answer, in milliseconds.
 *
 * The interval grows while the workflow does not wait, so that a long run sends few queries,
 * and starts again from the shortest after each answer.
 */
const minPollIntervalMs = 200;
const maxPollIntervalMs = 2000;

/** Options of {@link answerWaits}. */
export interface AnswerWaitsOptions {
  handle: WorkflowHandle;
  plugins: PluginRegistry;
  /** Reports a progress event of a wait step, and resolves after the event is shown. */
  report: (event: WorkflowEvent) => Promise<void>;
  /** Shows the events that the run has stored so far. */
  flush: () => Promise<void>;
  /** Stops answering when aborted, such as when the run ends or is interrupted. */
  signal: AbortSignal;
}

const formatPrefixedErrors = (prefix: string, errors: { path: unknown[]; message: string }[]) =>
  errors.map(({ message, path }) => `${[prefix, ...path].join(".")}: ${message}`).join("\n");

/** Asks the method of a waiting step for an answer until the workflow accepts one. */
const answerStep = async (
  { answers, method: name, options, step }: WaitingStep,
  { flush, handle, plugins, report, signal }: AnswerWaitsOptions,
): Promise<void> => {
  const method = plugins.waitMethod(name);
  if (method?.respond === undefined) {
    throw new Error(`steps.${step}: Wait method ${name} cannot answer in this process`);
  }
  const validated = validateWithSchema(method.with, options);
  if (!validated.ok) {
    throw new Error(formatPrefixedErrors(`steps.${step}.with`, validated.errors));
  }

  // The workflow stores the start of the step before it waits, so it is shown before the
  // questions of the method.
  await flush();
  for (;;) {
    const values = await method.respond({ answers, options: validated.value, signal, step });
    try {
      const answer: Answer = { step, values };
      await handle.executeUpdate(answerUpdateName, { args: [answer] });
      return;
    } catch (error) {
      // The workflow rejected the answer, so the method asks again.
      if (!(error instanceof WorkflowUpdateFailedError)) {
        throw error;
      }
      const reason = error.cause instanceof Error ? error.cause.message : error.message;
      await report({ step, stream: "stderr", text: `${reason}\n`, type: "stepOutput" });
    }
  }
};

/**
 * Answers the wait steps of a run with the methods of the plugins, until the signal is aborted.
 *
 * @throws When a step cannot be answered, such as when its method fails.
 */
export const answerWaits = async (options: AnswerWaitsOptions): Promise<void> => {
  const { handle, signal } = options;
  let interval = minPollIntervalMs;
  while (!signal.aborted) {
    // The query fails while no Worker can run it and after the workflow closes. The result of
    // the workflow reports those cases.
    const waiting = await handle
      .query<WaitingStep | null>(waitingQueryName)
      .catch((): WaitingStep | null => null);
    if (waiting !== null && !signal.aborted) {
      await answerStep(waiting, options);
      interval = minPollIntervalMs;
      continue;
    }
    await sleep(interval, undefined, { signal }).catch(() => {});
    interval = Math.min(interval * 2, maxPollIntervalMs);
  }
};
