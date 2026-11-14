import { access, readdir } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

/** Directory that holds ugoke files at the project root. */
export const ugokeDirectory = ".ugoke";

const segmentPattern = /^[A-Za-z][A-Za-z0-9_-]*$/u;
const extensions = [".yaml", ".yml"];

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/** Finds the project root, the nearest directory that contains `.ugoke`. */
export const findProjectRoot = async (cwd: string): Promise<string | undefined> => {
  let directory = cwd;
  while (!(await exists(join(directory, ugokeDirectory)))) {
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
  return directory;
};

/** Result of {@link listWorkflows}. */
export type ListResult =
  | {
      ok: true;
      names: string[];
      /** Definition files whose names cannot be workflow names, relative to the project root. */
      skipped: string[];
    }
  | { ok: false; message: string };

/** Lists the names of the workflows of a project, in order, such as `deploy` or `release/notes`. */
export const listWorkflows = async (cwd: string): Promise<ListResult> => {
  const root = await findProjectRoot(cwd);
  if (root === undefined) {
    return { message: `No ${ugokeDirectory} directory found in ${cwd} or its parents`, ok: false };
  }
  const directory = join(root, ugokeDirectory, "workflows");
  if (!(await exists(directory))) {
    return { names: [], ok: true, skipped: [] };
  }
  const files = await readdir(directory, { recursive: true });
  const names = new Set<string>();
  const skipped: string[] = [];
  for (const file of files.toSorted()) {
    const extension = extensions.find((candidate) => file.endsWith(candidate));
    if (extension !== undefined) {
      const name = file.slice(0, -extension.length).split(sep).join("/");
      if (name.split("/").every((segment) => segmentPattern.test(segment))) {
        // A name with both .yaml and .yml is listed once, and resolving it reports the problem.
        names.add(name);
      } else {
        skipped.push(join(ugokeDirectory, "workflows", file));
      }
    }
  }
  return { names: [...names].toSorted(), ok: true, skipped };
};

/** Result of {@link resolveWorkflow}. */
export type ResolveResult =
  | { ok: true; root: string; file: string }
  | { ok: false; message: string };

/**
 * Resolves a workflow name such as `deploy` or `release/notes` to its definition file.
 *
 * Definitions are read from `.ugoke/workflows` under the project root.
 */
export const resolveWorkflow = async (cwd: string, name: string): Promise<ResolveResult> => {
  if (!name.split("/").every((segment) => segmentPattern.test(segment))) {
    return {
      message: `Invalid workflow name: ${name}. Use letters, digits, _, and -, separated by /`,
      ok: false,
    };
  }

  const root = await findProjectRoot(cwd);
  if (root === undefined) {
    return { message: `No ${ugokeDirectory} directory found in ${cwd} or its parents`, ok: false };
  }

  const base = join(root, ugokeDirectory, "workflows", name);
  const files: string[] = [];
  for (const extension of extensions) {
    if (await exists(base + extension)) {
      files.push(base + extension);
    }
  }

  const [file, ...others] = files;
  if (file === undefined) {
    return { message: `Workflow not found: ${name}`, ok: false };
  }
  if (others.length > 0) {
    return { message: `Workflow ${name} has both .yaml and .yml files`, ok: false };
  }
  return { file, ok: true, root };
};
