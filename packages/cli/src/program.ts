import { createRequire } from "node:module";

import { Command } from "@commander-js/extra-typings";

import { validate } from "./commands/validate.js";
import type { CommandContext } from "./commands/validate.js";

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
}

const processContext = (): ProgramContext => ({
  cwd: process.cwd(),
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

  return program;
};
