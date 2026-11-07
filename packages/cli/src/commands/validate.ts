import { readFile } from "node:fs/promises";
import { relative } from "node:path";

import { compileDefinition } from "@aitw/definition";
import type { DefinitionError } from "@aitw/definition";

import { resolveWorkflow } from "../workflows.js";

/** Environment that a command runs in. */
export interface CommandContext {
  cwd: string;
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
 * Validates a workflow definition.
 *
 * @returns The exit code of the command.
 */
export const validate = async (name: string, context: CommandContext): Promise<number> => {
  const resolved = await resolveWorkflow(context.cwd, name);
  if (!resolved.ok) {
    context.stderr(`${resolved.message}\n`);
    return 1;
  }

  const file = relative(context.cwd, resolved.file);
  let source: string;
  try {
    source = await readFile(resolved.file, "utf8");
  } catch (error) {
    context.stderr(`${file}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const result = compileDefinition(source);
  if (!result.ok) {
    for (const error of result.errors) {
      context.stderr(formatError(file, error));
    }
    return 1;
  }

  context.stdout(`${name}: valid\n`);
  return 0;
};
