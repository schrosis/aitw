/**
 * Version of the code of the interpreter workflow, recorded with each run.
 *
 * Temporal replays the history of a run with the current workflow code when the run continues.
 * Raise this version when a change of the workflow code cannot replay the history of earlier
 * runs, and record the replay histories again. Prefer changes that can replay, such as with
 * `patched()` of `@temporalio/workflow`.
 */
export const workflowCodeVersion = 2;

/** Key of the memo of a run that holds {@link workflowCodeVersion} of the code that started it. */
export const workflowCodeVersionMemoKey = "aitwWorkflowCodeVersion";

/** Thrown when a run was started by workflow code of another version. */
export class IncompatibleRunError extends Error {
  readonly workflowId: string;
  /** Version of the code that started the run, or `undefined` when the run has none. */
  readonly runVersion: string | undefined;

  constructor(workflowId: string, runVersion: string | undefined) {
    super(
      `${workflowId} was started by workflow code version ${runVersion ?? "unknown"}, and this aitw has version ${workflowCodeVersion}. Continuing it can fail`,
    );
    this.name = "IncompatibleRunError";
    this.workflowId = workflowId;
    this.runVersion = runVersion;
  }
}

/** Returns whether a memo of a run records the workflow code version of this package. */
export const isCompatibleMemo = (memo: Readonly<Record<string, unknown>> | undefined): boolean =>
  memo?.[workflowCodeVersionMemoKey] === String(workflowCodeVersion);
