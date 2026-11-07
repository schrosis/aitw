/**
 * Source of the pattern for names in workflows, such as step IDs and input and output names.
 *
 * Expressions use the same pattern, so that references can match the names they refer to.
 */
export const identifierSource = "[A-Za-z][A-Za-z0-9_]*";

/** Pattern that matches a whole name in a workflow. */
export const identifierPattern = new RegExp(`^${identifierSource}$`, "u");
