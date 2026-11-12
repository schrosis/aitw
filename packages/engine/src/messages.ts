import type { InputDeclaration, WaitRespondIn } from "@aitw/core";

/**
 * Messages between the interpreter workflow and the processes that follow a run.
 *
 * This module has no Temporal imports, so that both the workflow and its clients can use it.
 */

/** Name of the query that returns the wait step that the workflow waits on, if any. */
export const waitingQueryName = "aitw.waiting";

/** Name of the update that answers a waiting step. */
export const answerUpdateName = "aitw.answer";

/** A wait step that waits for an answer. */
export interface WaitingStep {
  /** ID of the step. */
  step: string;
  /** How many times the step ran before, which tells the visits of a loop apart. */
  visit: number;
  /** Name of the wait method, as the definition writes it. */
  method: string;
  /** Options from `with`, after its expressions are evaluated. */
  options: Readonly<Record<string, unknown>>;
  /** Declarations of the answers that the workflow accepts. */
  answers: Readonly<Record<string, InputDeclaration>>;
  /**
   * Where the method answers. A step that the Worker answers does not accept answers from the
   * process that follows the run. Runs of earlier versions do not report it.
   */
  respondIn?: WaitRespondIn | undefined;
  /** Values of the workflow input. Runs of earlier versions do not report them. */
  workflowInputs?: Readonly<Record<string, unknown>> | undefined;
}

/** Argument of the answer update. */
export interface Answer {
  /** ID of the step that the answer is for, so that an old answer cannot answer a later step. */
  step: string;
  /** Visit of the step that the answer is for, so that it cannot answer a later visit. */
  visit?: number | undefined;
  /** Values of the answers, keyed by name. Defaults are applied by the workflow. */
  values: Readonly<Record<string, unknown>>;
}
