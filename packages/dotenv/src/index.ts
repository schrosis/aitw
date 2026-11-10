import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseEnv } from "node:util";

/** Result of {@link readDotenv}. */
export type DotenvResult =
  | { ok: true; values: NodeJS.Dict<string> }
  | { ok: false; message: string };

/**
 * Reads a dotenv file, relative to the working directory.
 *
 * The file is read each time a step runs, so its values never enter the workflow history. A file
 * that a symbolic link puts outside of the working directory is not read.
 */
export const readDotenv = (cwd: string, path: string): DotenvResult => {
  const failure = (reason: string): DotenvResult => ({
    message: `Failed to read the dotenv file ${path}: ${reason}`,
    ok: false,
  });
  let file: string;
  try {
    const root = realpathSync(cwd);
    file = realpathSync(resolve(cwd, path));
    const inside = relative(root, file);
    // Segments are compared, so that a file such as ..env in the root is inside.
    if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      return failure("it is outside of the project root");
    }
    return { ok: true, values: parseEnv(readFileSync(file, "utf8")) };
  } catch (error) {
    // The reason is kept in the message, so that it is reported with the step.
    return failure(error instanceof Error ? error.message : String(error));
  }
};

/**
 * Returns the environment that a step sees besides the variables of its definition, which take
 * precedence over it.
 *
 * Inherited variables take precedence over the dotenv file. Scripts, AI steps, and conditions all
 * use it, so that they see the same values.
 */
export const readEnvironment = (cwd: string, dotenv: string | undefined): DotenvResult => {
  if (dotenv === undefined) {
    return { ok: true, values: { ...process.env } };
  }
  const file = readDotenv(cwd, dotenv);
  return file.ok ? { ok: true, values: { ...file.values, ...process.env } } : file;
};
