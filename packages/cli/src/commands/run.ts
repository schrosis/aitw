import { createLocalScriptRunner } from "@aitw/adapter-script-local";
import { runWorkflow } from "@aitw/engine";

import { resolve } from "node:path";

import { createProgressPrinter } from "../progress.js";
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
      /** Temporal CLI to start the server with. The pinned release is used when it is omitted. */
      temporalBin?: string | undefined;
    };

/** Options of {@link run}. */
export interface RunOptions {
  /** Temporal Server that runs the workflow. */
  server: ServerOptions;
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
  { prepareEngine, server, signal }: RunOptions,
  context: CommandContext,
): Promise<number> => {
  const workflow = await loadWorkflow(name, context);
  if (workflow === undefined) {
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
            })
          : resolve(context.cwd, server.temporalBin);
      devServer = await startDevServer({
        dbFilename:
          server.dbFilename === undefined ? undefined : resolve(context.cwd, server.dbFilename),
        executable,
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
  } finally {
    await devServer?.stop();
  }
};
