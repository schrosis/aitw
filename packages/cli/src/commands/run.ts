import { resolveWorkflowInput } from "@aitw/core";
import { jsonBytes, maxValueBytes, runWorkflow, startWorkflow } from "@aitw/engine";

import { realpath } from "node:fs/promises";

import { cancelledExitCode, followRun, rootMessage } from "../follow.js";
import { readWorkflowInput } from "../input.js";
import { acquireRunLock } from "../lock.js";
import type { RunLock } from "../lock.js";
import { openCommandServer } from "../daemon/connect.js";
import { loadEncryptionKey } from "../encryption.js";
import type { OpenedServer, ServerOptions } from "../server.js";
import { projectHash, projectLockDirectory, projectMemoKey, workflowMemoKey } from "../state.js";
import { loadWorkflow } from "./load.js";
import type { CommandContext } from "./load.js";

/** Options of {@link run}. */
export interface RunOptions {
  /** Value of `--input`: a JSON object, or the path of a `.json` file. */
  input?: string | undefined;
  /**
   * Temporal Server that runs the workflow. Without it, the resident process of this host runs
   * the steps.
   */
  server?: ServerOptions | undefined;
  /**
   * Aborted when the user interrupts. It detaches the run, or cancels it on a server that does
   * not keep its runs.
   */
  signal: AbortSignal;
  /** Called after the workflow is validated and before it starts. */
  prepareEngine?: () => void;
  /**
   * Starts the run and exits without following it. The resident process runs the steps, and
   * the questions of the run wait in `aitw inbox list`.
   */
  detach?: boolean | undefined;
  /**
   * Version of this aitw. When the server is not given, a resident process of the same version
   * runs the steps.
   */
  version: string;
}

/**
 * Runs a workflow and waits for it to finish.
 *
 * Scripts run in the project root.
 *
 * @returns The exit code of the command.
 */
export const run = async (
  name: string,
  { detach = false, input: inputOption, prepareEngine, server, signal, version }: RunOptions,
  context: CommandContext,
): Promise<number> => {
  const workflow = await loadWorkflow(name, context);
  if (workflow === undefined) {
    return 1;
  }

  const read =
    inputOption === undefined
      ? { ok: true as const, values: {} }
      : await readWorkflowInput(inputOption, context.cwd);
  if (!read.ok) {
    context.stderr(`${name}: ${read.message}\n`);
    return 1;
  }
  // The workflow validates the input again, but checking it here avoids starting a server.
  const resolved = resolveWorkflowInput(workflow.intermediate.inputs, read.values);
  if (!resolved.ok) {
    for (const { message, path } of resolved.errors) {
      context.stderr(`${name}: ${["workflow.inputs", ...path].join(".")}: ${message}\n`);
    }
    return 1;
  }
  const bytes = jsonBytes(resolved.inputs);
  if (bytes > maxValueBytes) {
    context.stderr(
      `${name}: workflow.inputs is ${bytes} bytes, which exceeds the limit of ${maxValueBytes} bytes\n`,
    );
    return 1;
  }

  let opened: OpenedServer | undefined;
  try {
    const root = await realpath(workflow.root);
    const { server: commandServer, servedTaskQueue } = await openCommandServer(
      { detach, server, version },
      root,
      context,
      signal,
    );
    opened = commandServer;
    if (signal.aborted) {
      context.stderr(`${name}: cancelled\n`);
      return cancelledExitCode;
    }

    const memo = { [projectMemoKey]: projectHash(root), [workflowMemoKey]: name };
    if (detach) {
      // The run goes on after this command only in the resident process. The reason why it does
      // not run the steps is already shown.
      if (servedTaskQueue === undefined) {
        context.stderr(`${name}: cannot detach, because aitw daemon does not run the steps\n`);
        return 1;
      }
      const workflowId = await startWorkflow({
        address: opened.address,
        encryptionKey: loadEncryptionKey(),
        inputs: read.values,
        intermediate: workflow.intermediate,
        memo,
        name,
        taskQueue: servedTaskQueue,
      });
      context.stdout(
        `${name}: started ${workflowId} in aitw daemon. Its questions wait in "aitw inbox list", and "aitw resume ${workflowId}" follows it\n`,
      );
      return 0;
    }

    prepareEngine?.();
    let lock: RunLock | undefined;
    try {
      return await followRun(
        {
          follow: async (options) =>
            runWorkflow({
              ...options,
              inputs: read.values,
              intermediate: workflow.intermediate,
              // The memo marks the run, so that aitw resume can find the runs of a project.
              memo,
              name,
              // aitw resume does not follow a run that this process follows.
              onStart: (workflowId) => {
                lock = acquireRunLock(projectLockDirectory(root), workflowId);
              },
              // The resident process runs the steps on the task queue of the project.
              ...(servedTaskQueue === undefined
                ? {}
                : { startWorker: false, taskQueue: servedTaskQueue }),
            }),
          interrupt: signal,
          name,
          ownsWorker: servedTaskQueue === undefined,
          root,
          server: opened,
          steps: Object.keys(workflow.intermediate.steps),
        },
        context,
      );
    } finally {
      lock?.release();
    }
  } catch (error) {
    // An interrupt while the server starts aborts the download or the wait for the server.
    if (signal.aborted) {
      context.stderr(`${name}: cancelled\n`);
      return cancelledExitCode;
    }
    context.stderr(`${name}: failed: ${rootMessage(error)}\n`);
    return 1;
  } finally {
    await opened?.stop();
  }
};
