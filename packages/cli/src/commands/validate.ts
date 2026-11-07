import { readFile } from "node:fs/promises";

import { compileDefinition } from "@aitw/definition";
import type { DefinitionError } from "@aitw/definition";

/** Streams that a command writes to. */
export interface CommandOutput {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const formatPath = (path: readonly (number | string)[]): string =>
  path
    .map((segment) => (typeof segment === "number" ? `[${segment}]` : `.${segment}`))
    .join("")
    .slice(1);

const formatError = (file: string, { column, line, message, path }: DefinitionError): string => {
  const location = path.length > 0 ? ` ${formatPath(path)}:` : "";
  return `${file}:${line}:${column}${location} ${message}\n`;
};

/**
 * Validates a workflow definition file.
 *
 * @returns The exit code of the command.
 */
export const validate = async (file: string, output: CommandOutput): Promise<number> => {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    output.stderr(`${file}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const result = compileDefinition(source);
  if (!result.ok) {
    for (const error of result.errors) {
      output.stderr(formatError(file, error));
    }
    return 1;
  }

  output.stdout(`${file}: valid\n`);
  return 0;
};
