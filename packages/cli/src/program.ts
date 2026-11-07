import { createRequire } from "node:module";

import { Command } from "@commander-js/extra-typings";

import { validate } from "./commands/validate.js";
import type { CommandOutput } from "./commands/validate.js";

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

const processOutput: CommandOutput = {
  stderr: (text) => process.stderr.write(text),
  stdout: (text) => process.stdout.write(text),
};

/** Creates the `aitw` command line program. */
export const createProgram = (output: CommandOutput = processOutput) => {
  const program = new Command()
    .name("aitw")
    .description("Run workflows that combine AI, people, and scripts")
    .version(readVersion());

  program
    .command("validate")
    .description("Validate a workflow definition file")
    .argument("<file>", "workflow definition file")
    .action(async (file) => {
      process.exitCode = await validate(file, output);
    });

  return program;
};
