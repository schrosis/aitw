import { createRequire } from "node:module";

import { Command } from "@commander-js/extra-typings";

import type { CommandContext } from "./commands/load.js";
import { run } from "./commands/run.js";
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
  /** Aborted when the user interrupts the program. */
  signal: AbortSignal;
}

const interruptSignal = (): AbortSignal => {
  const controller = new AbortController();
  // A second interrupt falls back to the default behavior and exits immediately.
  process.once("SIGINT", () => controller.abort());
  return controller.signal;
};

const processContext = (): ProgramContext => ({
  cwd: process.cwd(),
  signal: interruptSignal(),
  setExitCode: (code) => {
    process.exitCode = code;
  },
  stderr: (text) => process.stderr.write(text),
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
    .option("--address <address>", "address of the Temporal Server", "localhost:7233")
    .action(async (workflow, { address }) => {
      context.setExitCode(await run(workflow, { address, signal: context.signal }, context));
    });

  return program;
};
