import { access } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Directory that holds aitw files at the project root. */
export const aitwDirectory = ".aitw";

const segmentPattern = /^[A-Za-z][A-Za-z0-9_-]*$/u;
const extensions = [".yaml", ".yml"];

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/** Finds the project root, the nearest directory that contains `.aitw`. */
export const findProjectRoot = async (cwd: string): Promise<string | undefined> => {
  let directory = cwd;
  while (!(await exists(join(directory, aitwDirectory)))) {
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
  return directory;
};

/** Result of {@link resolveWorkflow}. */
export type ResolveResult =
  | { ok: true; root: string; file: string }
  | { ok: false; message: string };

/**
 * Resolves a workflow name such as `deploy` or `release/notes` to its definition file.
 *
 * Definitions are read from `.aitw/workflows` under the project root.
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
    return { message: `No ${aitwDirectory} directory found in ${cwd} or its parents`, ok: false };
  }

  const base = join(root, aitwDirectory, "workflows", name);
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
