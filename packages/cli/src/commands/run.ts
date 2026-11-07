import { createLocalScriptRunner } from "@aitw/adapter-script-local";
import { runWorkflow } from "@aitw/engine";

import { createProgressPrinter } from "../progress.js";
import { loadWorkflow } from "./load.js";
import type { CommandContext } from "./load.js";

/** Exit code of a run that was cancelled, following the shell convention for SIGINT. */
const cancelledExitCode = 130;

/** Options of {@link run}. */
export interface RunOptions {
  /** Address of the Temporal Server. */
  address: string;
  /** Cancels the run when aborted. */
  signal: AbortSignal;
  /** Called after the workflow is validated and before it starts. */
  prepareEngine?: () => void;
}

const isCancelled = (error: unknown): boolean =>
  error instanceof Error && error.cause instanceof Error && error.cause.name === "CancelledFailure";

/** Returns the message of the innermost cause, which describes the actual failure. */
const rootMessage = (error: unknown): string => {
  let current = error;
  while (current instanceof Error && current.cause instanceof Error) {
    current = current.cause;
  }
  return current instanceof Error ? current.message : String(current);
};

/**
 * Runs a workflow and waits for it to finish.
 *
 * Scripts run in the project root.
 *
 * @returns The exit code of the command.
 */
export const run = async (
  name: string,
  { address, prepareEngine, signal }: RunOptions,
  context: CommandContext,
): Promise<number> => {
  const workflow = await loadWorkflow(name, context);
  if (workflow === undefined) {
    return 1;
  }

  prepareEngine?.();
  try {
    const { executedSteps } = await runWorkflow({
      address,
      eventSink: createProgressPrinter(context),
      intermediate: workflow.intermediate,
      name,
      scriptRunner: createLocalScriptRunner({ cwd: workflow.root }),
      signal,
    });
    context.stdout(`${name}: completed (${executedSteps.join(", ")})\n`);
    return 0;
  } catch (error) {
    if (isCancelled(error)) {
      context.stderr(`${name}: cancelled\n`);
      return cancelledExitCode;
    }
    context.stderr(`${name}: failed: ${rootMessage(error)}\n`);
    return 1;
  }
};
