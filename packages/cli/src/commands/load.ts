import { readFile } from "node:fs/promises";
import { relative } from "node:path";

import type { Intermediate } from "@aitw/core";
import { compileDefinition } from "@aitw/definition";
import type { DefinitionError } from "@aitw/definition";

import { resolveWorkflow } from "../workflows.js";

/** Environment that a command runs in. */
export interface CommandContext {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** A workflow that passed validation. */
export interface LoadedWorkflow {
  /** Project root, the directory that contains `.aitw`. */
  root: string;
  intermediate: Intermediate;
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
 * Resolves, reads, and compiles a workflow, writing any errors to standard error.
 *
 * @returns The compiled workflow, or `undefined` when it cannot be used.
 */
export const loadWorkflow = async (
  name: string,
  context: CommandContext,
): Promise<LoadedWorkflow | undefined> => {
  const resolved = await resolveWorkflow(context.cwd, name);
  if (!resolved.ok) {
    context.stderr(`${resolved.message}\n`);
    return undefined;
  }

  const file = relative(context.cwd, resolved.file);
  let source: string;
  try {
    source = await readFile(resolved.file, "utf8");
  } catch (error) {
    context.stderr(`${file}: ${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }

  const result = compileDefinition(source);
  if (!result.ok) {
    for (const error of result.errors) {
      context.stderr(formatError(file, error));
    }
    return undefined;
  }

  return { intermediate: result.intermediate, root: resolved.root };
};
