import { createRequire } from "node:module";

import { configureRuntime } from "@aitw/engine";
import { Command, Option } from "@commander-js/extra-typings";

import type { CommandContext } from "./commands/load.js";
import { run } from "./commands/run.js";
import type { ServerOptions } from "./commands/run.js";
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

const processContext = (): ProgramContext => ({
  cwd: process.cwd(),
  interruptSignal,
  prepareEngine,
  setExitCode: (code) => {
    process.exitCode = code;
  },
  stderr: (text) => process.stderr.write(text),
  stdin: () => process.stdin,
  stdout: (text) => process.stdout.write(text),
});

/** Creates the `aitw` command line program. */
export const createProgram = (context: ProgramContext = processContext()) => {
  const program = new Command()
    .name("aitw")
    .description("Run workflows that combine AI, people, and scripts")
    .version(readVersion());

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
    .addOption(
      new Option("--address <address>", "address of the Temporal Server")
        .default("localhost:7233")
        .conflicts("dev"),
    )
    .option("--input <json-or-file>", "workflow input as a JSON object or the path of a .json file")
    .option("--dev", "start a temporary Temporal development server for this run")
    .option("--dev-db <path>", "keep the state of the development server in a SQLite file")
    .option(
      "--temporal-bin <path>",
      "Temporal CLI to start the development server with, as a path or a name in PATH",
    )
    .action(async (workflow, { address, dev, devDb, input, temporalBin }, command) => {
      if (!dev && (devDb !== undefined || temporalBin !== undefined)) {
        command.error("error: --dev-db and --temporal-bin require --dev");
      }
      const signal = context.interruptSignal();
      const server: ServerOptions = dev
        ? { dbFilename: devDb, temporalBin, type: "dev" }
        : { address, type: "address" };
      context.setExitCode(
        await run(
          workflow,
          { input, prepareEngine: context.prepareEngine, server, signal },
          context,
        ),
      );
    });

  return program;
};
