/**
 * Source of the pattern for names in workflows, such as step IDs and input and output names.
 *
 * Expressions use the same pattern, so that references can match the names they refer to.
 */
export const identifierSource = "[A-Za-z][A-Za-z0-9_]*";

/** Pattern that matches a whole name in a workflow. */
export const identifierPattern = new RegExp(`^${identifierSource}$`, "u");

/**
 * Pattern of the name of an environment variable that a definition sets.
 *
 * It follows the names that shells accept, which may start with `_`.
 */
export const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Message for a name that does not match {@link envNamePattern}. */
export const envNameMessage =
  "Must start with a letter or _ and contain only letters, digits, or _";

/**
 * Checks the path of a dotenv file, relative to the project root.
 *
 * @returns A message when the path is absolute or leaves the project root, or `undefined`.
 */
export const checkDotenvPath = (path: string): string | undefined => {
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path)) {
    return "Must be a path relative to the project root";
  }
  if (path.split(/[\\/]/u).includes("..")) {
    return "Must not leave the project root";
  }
  return undefined;
};
