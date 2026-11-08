import { createLocalScriptRunner } from "@aitw/adapter-script-local";
import { resolveWorkflowInput } from "@aitw/core";
import { jsonBytes, maxValueBytes, runWorkflow } from "@aitw/engine";

import { resolve } from "node:path";

import { createProgressPrinter } from "../progress.js";
import { readWorkflowInput } from "../input.js";
import { ensureTemporalCli, startDevServer } from "../temporal-cli/index.js";
import type { DevServer } from "../temporal-cli/index.js";
import { loadWorkflow } from "./load.js";
import type { CommandContext } from "./load.js";

/** Exit code of a run that was cancelled, following the shell convention for SIGINT. */
const cancelledExitCode = 130;

/** Temporal Server that a run uses. */
export type ServerOptions =
  | { type: "address"; address: string }
  | {
      type: "dev";
      /** SQLite file that keeps the server state, relative to the current directory. */
      dbFilename?: string | undefined;
      /**
       * Temporal CLI to start the server with, as a path or a name in PATH. The pinned release is
       * used when it is omitted.
       */
      temporalBin?: string | undefined;
    };

/** Options of {@link run}. */
export interface RunOptions {
  /** Value of `--input`: a JSON object, or the path of a `.json` file. */
  input?: string | undefined;
  /** Temporal Server that runs the workflow. */
  server: ServerOptions;
  /** Cancels the run when aborted. */
  signal: AbortSignal;
  /** Called after the workflow is validated and before it starts. */
  prepareEngine?: () => void;
}

const isCancelled = (error: unknown): boolean =>
  error instanceof Error && error.cause instanceof Error && error.cause.name === "CancelledFailure";

/** Resolves an executable like a shell: a name without a slash is looked up in PATH. */
const resolveExecutable = (cwd: string, executable: string): string =>
  executable.includes("/") ? resolve(cwd, executable) : executable;

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
  { input: inputOption, prepareEngine, server, signal }: RunOptions,
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

  let devServer: DevServer | undefined;
  try {
    let address: string;
    if (server.type === "dev") {
      const executable =
        server.temporalBin === undefined
          ? await ensureTemporalCli({
              onDownload: (version) => context.stderr(`Downloading Temporal CLI ${version}\n`),
              signal,
            })
          : resolveExecutable(context.cwd, server.temporalBin);
      devServer = await startDevServer({
        dbFilename:
          server.dbFilename === undefined ? undefined : resolve(context.cwd, server.dbFilename),
        executable,
        signal,
      });
      address = devServer.address;
      context.stderr(`Temporal Web UI: ${devServer.uiUrl}\n`);
    } else {
      address = server.address;
    }
    if (signal.aborted) {
      context.stderr(`${name}: cancelled\n`);
      return cancelledExitCode;
    }

    prepareEngine?.();
    const { executedSteps } = await runWorkflow({
      address,
      eventSink: createProgressPrinter(context),
      inputs: read.values,
      intermediate: workflow.intermediate,
      name,
      scriptRunner: createLocalScriptRunner({ cwd: workflow.root }),
      signal,
    });
    context.stdout(`${name}: completed (${executedSteps.join(", ")})\n`);
    return 0;
  } catch (error) {
    // An interrupt while the server starts aborts the download or the wait for the server.
    if (isCancelled(error) || signal.aborted) {
      context.stderr(`${name}: cancelled\n`);
      return cancelledExitCode;
    }
    context.stderr(`${name}: failed: ${rootMessage(error)}\n`);
    return 1;
  } finally {
    await devServer?.stop();
  }
};
