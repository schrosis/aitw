import { createRequire } from "node:module";

import { configureRuntime } from "@aitw/engine";
import { Command, Option } from "@commander-js/extra-typings";

import type { CommandContext } from "./commands/load.js";
import { cancel, resume } from "./commands/resume.js";
import { run } from "./commands/run.js";
import { showDaemonStatus, startDaemon, stopDaemon } from "./daemon/commands.js";
import { runDaemon } from "./daemon/process.js";
import { defaultAddress } from "./server.js";
import type { ServerOptions } from "./server.js";
import { docs } from "./commands/docs.js";
import { validate } from "./commands/validate.js";

const readVersion = (): string => {
  const manifest: unknown = createRequire(import.meta.url)("../package.json");
  if (
    typeof manifest === "object" &&
    manifest !== null &&
    "version" in manifest &&
    typeof manifest.version === "string"
  ) {
    return manifest.version;
  }
  throw new Error("The package version is missing");
};

/** Environment of the program, injectable for tests. */
export interface ProgramContext extends CommandContext {
  setExitCode: (code: number) => void;
  /**
   * Returns a signal that is aborted when the user interrupts the program.
   *
   * Commands call it only when they can be cancelled, so that other commands keep the default
   * behavior of an interrupt.
   */
  interruptSignal: () => AbortSignal;
  /** Prepares the workflow engine before a command runs a workflow. */
  prepareEngine: () => void;
  /** Returns a signal that is aborted on SIGTERM or SIGINT, for the resident process. */
  stopSignal?: () => AbortSignal;
  /** Path of the aitw executable, which `aitw daemon start` runs in the background. */
  executable?: string;
}

/** Exit code of an interrupted program, following the shell convention for SIGINT. */
const interruptedExitCode = 130;

const interruptSignal = (): AbortSignal => {
  const controller = new AbortController();
  process.on("SIGINT", () => {
    if (controller.signal.aborted) {
      // A second interrupt exits immediately. process.exit() still runs the "exit" handlers,
      // which stop a development server.
      process.exit(interruptedExitCode);
    }
    controller.abort();
  });
  return controller.signal;
};

/**
 * Configures the Temporal runtime once, only for commands that run workflows.
 *
 * An installed runtime keeps the process alive until a Worker shuts it down, so commands that
 * finish without running a workflow must not install it.
 */
const prepareEngine = (() => {
  let prepared = false;
  return (): void => {
    if (!prepared) {
      // The CLI reports failures and handles SIGINT itself.
      configureRuntime({ logLevel: "ERROR" });
      prepared = true;
    }
  };
})();

const stopSignal = (): AbortSignal => {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return controller.signal;
};

const processContext = (): ProgramContext => ({
  cwd: process.cwd(),
  executable: process.argv[1] ?? "aitw",
  interruptSignal,
  stopSignal,
  prepareEngine,
  setExitCode: (code) => {
    process.exitCode = code;
  },
  stderr: (text) => process.stderr.write(text),
  stdin: () => process.stdin,
  stdout: (text) => process.stdout.write(text),
});

const devDbDescription = "keep the state of the development server in a SQLite file";
const devUiDescription =
  "also start the Web UI, which web pages that you open could use to run commands on this machine";
const temporalBinDescription =
  "Temporal CLI to start the development server with, as a path or a name in PATH";
const daemonHelp = `
When "aitw daemon" runs and no server options are given, the resident process runs the steps,
so the run keeps going after this command exits.`;
const interruptHelp = `
Press Ctrl+C to detach: the run waits in Temporal, and "aitw resume" continues it.
A running script finishes first. Press Ctrl+C again to exit now, which fails the running
step so that the run cannot be resumed. A development server without --dev-db keeps no
runs, so Ctrl+C cancels the run there. Use "aitw cancel" to stop a run.`;

const addressOption = () =>
  new Option("--address <address>", "address of the Temporal Server")
    .default(defaultAddress)
    .conflicts("dev");

/** Builds the server options of a command, and rejects options that need --dev. */
const toServerOptions = (
  {
    address,
    dev,
    devDb,
    devUi,
    temporalBin,
  }: {
    address: string;
    dev?: true | undefined;
    devDb?: string | undefined;
    devUi?: true | undefined;
    temporalBin?: string | undefined;
  },
  command: { error: (message: string) => never },
): ServerOptions => {
  if (dev !== true && (devDb !== undefined || devUi !== undefined || temporalBin !== undefined)) {
    command.error("error: --dev-db, --dev-ui, and --temporal-bin require --dev");
  }
  return dev === true
    ? { dbFilename: devDb, temporalBin, type: "dev", ui: devUi }
    : { address, type: "address" };
};

/**
 * Returns the version that a resident process must have to serve the command, or `undefined`
 * when the command names its server and runs its own Worker.
 */
const daemonVersionOf = (
  { dev }: { dev?: true | undefined },
  command: { getOptionValueSource: (key: string) => string | undefined },
  version: string,
): string | undefined =>
  dev === true || command.getOptionValueSource("address") === "cli" ? undefined : version;

/** Creates the `aitw` command line program. */
export const createProgram = (context: ProgramContext = processContext()) => {
  const version = readVersion();
  const program = new Command()
    .name("aitw")
    .description("Run workflows that combine AI, people, and scripts")
    .version(version);

  program
    .command("docs")
    .description("Generate a Markdown document next to each workflow definition")
    .argument("[workflow]", "workflow name, such as deploy or release/notes. Defaults to all")
    .action(async (workflow) => {
      context.setExitCode(await docs(workflow, context));
    });

  program
    .command("validate")
    .description("Validate a workflow definition in .aitw/workflows")
    .argument("<workflow>", "workflow name, such as deploy or release/notes")
    .action(async (workflow) => {
      context.setExitCode(await validate(workflow, context));
    });

  program
    .command("run")
    .description("Run a workflow in .aitw/workflows and wait for it to finish")
    .argument("<workflow>", "workflow name, such as deploy or release/notes")
    .addOption(addressOption())
    .option("--input <json-or-file>", "workflow input as a JSON object or the path of a .json file")
    .option("--dev", "start a temporary Temporal development server for this run")
    .option("--dev-db <path>", devDbDescription)
    .option("--temporal-bin <path>", temporalBinDescription)
    .option("--dev-ui", devUiDescription)
    .addHelpText(
      "after",
      `${interruptHelp}
${daemonHelp}`,
    )
    .action(async (workflow, { input, ...options }, command) => {
      const server = toServerOptions(options, command);
      const signal = context.interruptSignal();
      context.setExitCode(
        await run(
          workflow,
          {
            daemonVersion: daemonVersionOf(options, command, version),
            input,
            prepareEngine: context.prepareEngine,
            server,
            signal,
          },
          context,
        ),
      );
    });

  program
    .command("resume")
    .description("Resume a run of the project, such as one that was detached")
    .argument("[workflow-id]", "ID of the run. Without it, the runs of the project are listed")
    .addOption(addressOption())
    .option("--dev", "start a Temporal development server from --dev-db")
    .option("--dev-db <path>", devDbDescription)
    .option("--temporal-bin <path>", temporalBinDescription)
    .option("--dev-ui", devUiDescription)
    .option("--force", "resume a run that another version of aitw started, which can fail")
    .addHelpText(
      "after",
      `${interruptHelp}
${daemonHelp}`,
    )
    .action(async (workflowId, { force, ...options }, command) => {
      const server = toServerOptions(options, command);
      const signal = context.interruptSignal();
      context.setExitCode(
        await resume(
          {
            daemonVersion: daemonVersionOf(options, command, version),
            force,
            prepareEngine: context.prepareEngine,
            server,
            signal,
            workflowId,
          },
          context,
        ),
      );
    });

  program
    .command("cancel")
    .description("Cancel a run of the project, stopping its wait or its running script")
    .argument("[workflow-id]", "ID of the run. Without it, the runs of the project are listed")
    .addOption(addressOption())
    .option("--dev", "start a Temporal development server from --dev-db")
    .option("--dev-db <path>", devDbDescription)
    .option("--temporal-bin <path>", temporalBinDescription)
    .option("--dev-ui", devUiDescription)
    .action(async (workflowId, options, command) => {
      const server = toServerOptions(options, command);
      const signal = context.interruptSignal();
      context.setExitCode(
        await cancel(
          {
            daemonVersion: daemonVersionOf(options, command, version),
            prepareEngine: context.prepareEngine,
            server,
            signal,
            workflowId,
          },
          context,
        ),
      );
    });

  const daemon = program
    .command("daemon")
    .description(
      "Manage the resident process of this host, which keeps runs going in the background",
    );

  daemon
    .command("start")
    .description("Start the resident process in the background")
    .addHelpText(
      "after",
      `
Scripts that the resident process runs inherit its environment variables as they were when it
started, not those of the terminal that runs "aitw run". Pass the values that a workflow needs
with env and dotenv in the definition.`,
    )
    .addOption(addressOption())
    .option("--dev", "start a Temporal development server, which needs --dev-db")
    .option("--dev-db <path>", devDbDescription)
    .option("--temporal-bin <path>", temporalBinDescription)
    .option("--dev-ui", devUiDescription)
    .action(async (options, command) => {
      const server = toServerOptions(options, command);
      context.setExitCode(
        await startDaemon({ executable: context.executable ?? "aitw", server, version }, context),
      );
    });

  daemon
    .command("stop")
    .description("Stop the resident process")
    .action(async () => {
      context.setExitCode(await stopDaemon(context));
    });

  daemon
    .command("status")
    .description("Show the state of the resident process")
    .action(async () => {
      context.setExitCode(await showDaemonStatus(context));
    });

  // aitw daemon start runs this command in the background.
  daemon
    .command("run", { hidden: true })
    .addOption(addressOption())
    .option("--dev")
    .option("--dev-db <path>")
    .option("--temporal-bin <path>")
    .option("--dev-ui")
    .action(async (options, command) => {
      const server = toServerOptions(options, command);
      const signal = (context.stopSignal ?? context.interruptSignal)();
      context.setExitCode(
        await runDaemon({ prepareEngine: context.prepareEngine, server, signal, version }, context),
      );
    });

  return program;
};
