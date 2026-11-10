import { readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";

import { documentMarker, renderWorkflowDocument } from "@aitw/definition";

import { listWorkflows } from "../workflows.js";
import { loadWorkflow } from "./load.js";
import type { CommandContext } from "./load.js";

/** Returns the contents of a file, or `undefined` when it does not exist. */
const readExisting = async (file: string): Promise<string | undefined> => {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};

/** Generates the document of one workflow next to its definition, and returns whether it did. */
const generate = async (name: string, context: CommandContext): Promise<boolean> => {
  const workflow = await loadWorkflow(name, context);
  if (workflow === undefined) {
    return false;
  }

  const file = workflow.file.replace(/\.ya?ml$/u, ".md");
  const shown = relative(context.cwd, file);
  try {
    // A file without the marker is one that someone wrote, so it is not replaced.
    const existing = await readExisting(file);
    if (existing !== undefined && !existing.startsWith(documentMarker)) {
      context.stderr(`${shown}: aitw docs did not generate this file, so it was not replaced\n`);
      return false;
    }
    await writeFile(file, renderWorkflowDocument(workflow.intermediate));
  } catch (error) {
    context.stderr(`${shown}: ${error instanceof Error ? error.message : String(error)}\n`);
    return false;
  }
  context.stdout(`${name}: wrote ${shown}\n`);
  return true;
};

/**
 * Generates Markdown documents next to workflow definitions.
 *
 * Without a name, it generates every workflow, and continues after one that fails.
 *
 * @returns The exit code of the command.
 */
export const docs = async (name: string | undefined, context: CommandContext): Promise<number> => {
  let names = [name ?? ""];
  if (name === undefined) {
    const listed = await listWorkflows(context.cwd);
    if (!listed.ok) {
      context.stderr(`${listed.message}\n`);
      return 1;
    }
    for (const file of listed.skipped) {
      context.stderr(`${file}: skipped, because it is not a valid workflow name\n`);
    }
    names = listed.names;
  }

  let failed = false;
  for (const workflow of names) {
    failed = !(await generate(workflow, context)) || failed;
  }
  return failed ? 1 : 0;
};
