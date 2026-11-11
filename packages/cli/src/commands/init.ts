import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { aitwDirectory } from "../workflows.js";
import type { CommandContext } from "./load.js";
import { schemaDirectory, writeSchemas } from "./schema.js";

/** Configuration file that a new project starts with. */
const configSource = `$schema: ./${schemaDirectory}/config.schema.json
# Plugins to load, keyed by package name. Install a package before you add it, such as:
#   npm install --save-dev @aitw/adapter-ai-claude-code
# Run "aitw schema" again after changing plugins.
# plugins:
#   "@aitw/adapter-ai-claude-code":
`;

/** Workflow that a new project starts with, to try aitw. */
const helloSource = `$schema: ../${schemaDirectory}/workflow.schema.json
version: v0.1
start: hello
steps:
  hello:
    type: script
    run: echo "Hello from aitw"
    next: end
`;

const isAlreadyExists = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "EEXIST";

/**
 * Creates `.aitw` in the current directory, with the configuration file, a sample workflow, and
 * the JSON Schemas.
 *
 * The current directory becomes the project root. A directory that already has `.aitw` is left
 * as it is.
 *
 * @returns The exit code of the command.
 */
export const init = async (context: CommandContext): Promise<number> => {
  const directory = join(context.cwd, aitwDirectory);
  // Creating the directory also tells whether it exists, so that a project that another process
  // creates in the meantime is not mixed with this one.
  try {
    await mkdir(directory);
  } catch (error) {
    context.stderr(
      isAlreadyExists(error)
        ? `${aitwDirectory} already exists in ${context.cwd}\n`
        : `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  const written: string[] = [];
  try {
    const workflows = join(directory, "workflows");
    await mkdir(workflows);
    for (const [file, source] of [
      [join(directory, "config.yaml"), configSource],
      [join(workflows, "hello.yaml"), helloSource],
    ] as const) {
      await writeFile(file, source, { flag: "wx" });
      written.push(relative(context.cwd, file));
    }
    written.push(...(await writeSchemas(context.cwd, context.cwd)));
  } catch (error) {
    // This command created the directory, so removing it lets the command run again.
    await rm(directory, { force: true, recursive: true });
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  for (const file of written) {
    context.stdout(`wrote ${file}\n`);
  }
  context.stdout(`
Next:
  aitw daemon start
  aitw run hello
`);
  return 0;
};
