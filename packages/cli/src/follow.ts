import { createFileEventLog } from "@aitw/adapter-event-log-file";
import type { TerminalIO } from "@aitw/adapter-wait-terminal";
import { createLocalScriptRunner } from "@aitw/adapter-script-local";
import type { EventSink } from "@aitw/core";
import { IncompatibleRunError } from "@aitw/engine";
import type { FollowOptions, RunOutcome } from "@aitw/engine";

import type { CommandContext } from "./commands/load.js";
import { createLineReader } from "./lines.js";
import type { LineReader } from "./lines.js";
import { createRegistry } from "./plugins.js";
import { createProgressPrinter } from "./progress.js";
import type { OpenedServer } from "./server.js";
import { projectLogDirectory } from "./state.js";

/** Exit code of a run that was cancelled, following the shell convention for SIGINT. */
export const cancelledExitCode = 130;

/**
 * Exit code of a run that was left running to be resumed later.
 *
 * It is not zero, so that a script that runs aitw does not take the run as completed.
 */
export const detachedExitCode = 3;

/** Returns whether an error of the engine means that the run was cancelled. */
export const isCancelled = (error: unknown): boolean =>
  error instanceof Error && error.cause instanceof Error && error.cause.name === "CancelledFailure";

/** Returns the message of the innermost cause, which describes the actual failure. */
export const rootMessage = (error: unknown): string => {
  let current = error;
  while (current instanceof Error && current.cause instanceof Error) {
    current = current.cause;
  }
  return current instanceof Error ? current.message : String(current);
};

/** Creates the terminal that wait steps ask in. Standard input is opened only when it is read. */
export const createTerminal = (context: CommandContext): TerminalIO & { close: () => void } => {
  let lines: LineReader | undefined;
  let echo = false;
  return {
    close: () => lines?.close(),
    readLine: async (signal) => {
      if (context.stdin === undefined) {
        return null;
      }
      if (lines === undefined) {
        const input = context.stdin();
        // A terminal shows what is typed. Piped answers are shown here instead.
        echo = !("isTTY" in input && input.isTTY === true);
        lines = createLineReader(input);
      }
      const line = await lines.readLine(signal);
      if (echo && line !== null) {
        context.stdout(`${line}\n`);
      }
      return line;
    },
    write: context.stdout,
  };
};

/** Options of {@link followRun}. */
export interface FollowRunOptions {
  /** Name of the workflow, which prefixes the messages. */
  name: string;
  /** Real path of the project root, where scripts run and logs are kept. */
  root: string;
  server: OpenedServer;
  /**
   * Aborted when the user interrupts. On a server that keeps its runs, it detaches the run, so
   * that it can be resumed. Otherwise, it cancels the run.
   */
  interrupt: AbortSignal;
  /** Starts or resumes the run with the options that this module prepares. */
  follow: (options: FollowOptions) => Promise<RunOutcome>;
  /** Terminal that wait steps ask in, when the command already reads standard input. */
  terminal?: ReturnType<typeof createTerminal>;
  /**
   * Whether this process runs the scripts of the run. A run that a resident process serves
   * detaches at once, because its scripts keep running there.
   */
  ownsWorker?: boolean;
}

/**
 * Follows a run in the terminal and reports how it ended.
 *
 * @returns The exit code of the command.
 */
export const followRun = async (
  { follow, interrupt, name, ownsWorker = true, root, server, terminal: given }: FollowRunOptions,
  context: CommandContext,
): Promise<number> => {
  const terminal = given ?? createTerminal(context);
  const printer = createProgressPrinter(context);
  // The script that runs now, so that an interrupt can tell that the run waits for it.
  let runningScript: string | undefined;
  const eventSink: EventSink = {
    emit: (event) => {
      if (event.type === "stepStarted") {
        runningScript = event.run === undefined ? undefined : event.step;
      } else if (event.type === "stepFinished") {
        runningScript = undefined;
      }
      printer.emit(event);
    },
  };

  const detach = new AbortController();
  const onInterrupt = (): void => {
    // The interrupt can come while a question waits on the same line.
    context.stdout("\n");
    if (!server.durable) {
      return;
    }
    if (ownsWorker && runningScript !== undefined) {
      context.stderr(
        "Waiting for the running step to finish, so that the run can be resumed.\n" +
          "Press Ctrl+C again to exit now. The running step will fail, and the run cannot be resumed.\n",
      );
    }
    detach.abort();
  };
  interrupt.addEventListener("abort", onInterrupt, { once: true });

  try {
    const outcome = await follow({
      address: server.address,
      eventLog: createFileEventLog({ directory: projectLogDirectory(root) }),
      eventSink,
      onWarning: (message) => context.stderr(`${name}: warning: ${message}\n`),
      plugins: createRegistry(terminal),
      scriptRunner: createLocalScriptRunner({ cwd: root }),
      ...(server.durable ? { detach: detach.signal } : { signal: interrupt }),
    });
    if (outcome.status === "detached") {
      context.stderr(`${name}: detached. Run "aitw resume${server.options}" to continue\n`);
      return detachedExitCode;
    }
    context.stdout(`${name}: completed (${outcome.executedSteps.join(", ")})\n`);
    return 0;
  } catch (error) {
    if (isCancelled(error) || interrupt.aborted) {
      const note = server.durable
        ? ""
        : ". Runs on a development server without --dev-db cannot be resumed";
      context.stderr(`${name}: cancelled${note}\n`);
      return cancelledExitCode;
    }
    if (error instanceof IncompatibleRunError) {
      context.stderr(
        `${name}: ${error.message}. Resume it with the version of aitw that started it, or pass --force to try anyway\n`,
      );
      return 1;
    }
    context.stderr(`${name}: failed: ${rootMessage(error)}\n`);
    return 1;
  } finally {
    interrupt.removeEventListener("abort", onInterrupt);
    // A terminal that the caller passed is closed by the caller.
    if (given === undefined) {
      terminal.close();
    }
  }
};
