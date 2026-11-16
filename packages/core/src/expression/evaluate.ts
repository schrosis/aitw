import { ExpressionError } from "./lexer.js";
import { parseTemplate } from "./template.js";
import type { Template } from "./template.js";
import { evaluateValue, expressionReferences } from "./value.js";

/** Result of {@link evaluateTemplate}. */
export type EvaluateResult = { ok: true; value: unknown } | { ok: false; message: string };

/**
 * A value that a path reads. When the path goes through `null` before its end, the value is
 * `null`, and `nullAt` is the length of the part of the path that reads the `null`.
 */
type Resolved =
  | { ok: true; value: unknown; nullAt?: number }
  /** `missingAt` is the index of the segment that cannot be read. */
  | { ok: false; missingAt: number };

/**
 * Reads a path of own data properties.
 *
 * A path that goes through `null` reads as `null`, as in conditions, so that the fields of a
 * value that is absent, such as `result.data` of a failed AI step, can be referenced.
 */
const resolve = (context: Readonly<Record<string, unknown>>, path: readonly string[]): Resolved => {
  let value: unknown = context;
  for (const [index, segment] of path.entries()) {
    if (value === null) {
      return { nullAt: index, ok: true, value: null };
    }
    // Only own data properties are read, so that references cannot reach prototype members
    // or run getters.
    const descriptor =
      typeof value === "object" && value !== null
        ? Object.getOwnPropertyDescriptor(value, segment)
        : undefined;
    if (descriptor === undefined || !("value" in descriptor)) {
      return { missingAt: index, ok: false };
    }
    const next: unknown = descriptor.value;
    value = next;
  }
  return { ok: true, value };
};

/** Result of {@link readReference}. */
export type ReadReferenceResult = { ok: true; value: unknown } | { ok: false };

/**
 * Reads a reference of a template or a condition.
 *
 * - A path that goes through `null` reads as `null`.
 * - A path under `steps` that cannot be read is `null`, because the step or the visit may not
 *   have run. Validation checks that the step and the output exist.
 * - `env.<name>` is `null` when the context has `env` but not the name, because a variable may
 *   not be set.
 * - Any other path that cannot be read fails.
 *
 * An own property whose value is `undefined` reads as `null`.
 *
 * It is not public. Templates and conditions use it to read references in the same way.
 */
export const readReference = (
  context: Readonly<Record<string, unknown>>,
  path: readonly string[],
): ReadReferenceResult => {
  const resolved = resolve(context, path);
  if (resolved.ok) {
    return { ok: true, value: resolved.value ?? null };
  }
  if (path[0] === "steps") {
    return { ok: true, value: null };
  }
  // Only a missing name is null. A context without env, such as that of a template, cannot
  // read env at all.
  if (path[0] === "env" && resolved.missingAt === 1 && path.length === 2) {
    return { ok: true, value: null };
  }
  return { ok: false };
};

type Tree = Record<string, unknown>;

const isTree = (value: unknown): value is Tree => typeof value === "object" && value !== null;

/** Sets a value at a path, creating own objects on the way. */
const setPath = (tree: Tree, path: readonly string[], value: unknown): void => {
  let current = tree;
  for (const segment of path.slice(0, -1)) {
    // Only own properties are followed, because a name such as constructor is inherited.
    const existing = Object.hasOwn(current, segment) ? current[segment] : undefined;
    const next: Tree = isTree(existing) ? existing : {};
    current[segment] = next;
    current = next;
  }
  const last = path.at(-1);
  if (last !== undefined) {
    current[last] = value;
  }
};

/**
 * Sets a value that a path reads.
 *
 * For a path that goes through `null`, the `null` itself is set. Setting the whole path would
 * replace the `null` with an object, and another reference to it would read the object.
 */
const setPicked = (
  picked: Tree,
  path: readonly string[],
  resolved: Extract<Resolved, { ok: true }>,
): void => {
  setPath(
    picked,
    resolved.nullAt === undefined ? path : path.slice(0, resolved.nullAt),
    resolved.value,
  );
};

/**
 * Returns the part of a context that the `${{ }}` expressions in some strings read.
 *
 * It keeps only the referenced values, including those in the arguments of calls, so that a step
 * receives what its definition uses and not every value that the workflow holds.
 *
 * @param roots Names of the top-level context entries to pick from. Other references are left
 *   out, such as references to values that are not known yet.
 * @param paths Paths to pick in addition, such as the references of conditions.
 */
export const pickReferences = (
  texts: readonly string[],
  context: Readonly<Record<string, unknown>>,
  roots: ReadonlySet<string>,
  paths: readonly (readonly string[])[] = [],
): Tree => {
  const picked: Tree = {};
  const pick = (path: readonly string[]): void => {
    if (!roots.has(path[0] ?? "")) {
      return;
    }
    const resolved = resolve(context, path);
    if (resolved.ok) {
      setPicked(picked, path, resolved);
    }
  };
  paths.forEach(pick);
  for (const text of texts) {
    const parsed = parseTemplate(text);
    if (!parsed.ok) {
      continue;
    }
    for (const part of parsed.template) {
      if (part.type === "expression") {
        expressionReferences(part.expression).forEach(pick);
      }
    }
  }
  return picked;
};

/**
 * Converts a value to the string that a template embeds.
 *
 * Strings are kept as they are, `null` becomes an empty string, and objects and arrays are
 * converted to JSON.
 *
 * @throws When the value cannot be converted to JSON, such as a BigInt.
 */
export const embedValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  // A workflow input that is not given is null, and embeds like a missing value in a shell.
  if (value === null) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // JSON.stringify throws on values such as BigInt and circular references.
  return JSON.stringify(value) ?? "";
};

/**
 * Returns the index of the expression of a template that is one expression with only white space
 * around it, such as `${{ result.exitCode }}` followed by a line break of a YAML block scalar, or
 * `undefined`.
 *
 * White space is what `String.prototype.trim` removes.
 */
const onlyExpressionIndex = (template: Template): number | undefined => {
  let index: number | undefined;
  for (const [position, part] of template.entries()) {
    if (part.type === "text") {
      if (part.value.trim() !== "") {
        return undefined;
      }
    } else if (index === undefined) {
      index = position;
    } else {
      return undefined;
    }
  }
  return index;
};

/**
 * Evaluates a parsed template against the values that its references may read.
 *
 * A template that consists of a single expression, a reference or a call, with only white space
 * around it keeps the type of the value, and the white space is dropped. White space is what
 * `String.prototype.trim` removes. Otherwise the values are embedded into a string.
 *
 * References are read by {@link readReference}, also in the arguments of a call. A reference that
 * it cannot read is an error.
 */
export const evaluateTemplate = (
  template: Template,
  context: Readonly<Record<string, unknown>>,
): EvaluateResult => {
  const values: unknown[] = [];
  for (const part of template) {
    if (part.type === "text") {
      values.push(part.value);
      continue;
    }
    const read = (path: readonly string[]): unknown => {
      const result = readReference(context, path);
      if (!result.ok) {
        throw new ExpressionError("Unknown reference");
      }
      return result.value;
    };
    try {
      values.push(evaluateValue(part.expression, read));
    } catch (error) {
      if (error instanceof ExpressionError) {
        // Name the expression, because a field such as run can have many.
        return { message: `${error.message}: ${part.source}`, ok: false };
      }
      throw error;
    }
  }

  const only = onlyExpressionIndex(template);
  if (only !== undefined) {
    return { ok: true, value: values[only] };
  }
  try {
    return { ok: true, value: values.map(embedValue).join("") };
  } catch (error) {
    return {
      message: `Cannot embed a value: ${error instanceof Error ? error.message : String(error)}`,
      ok: false,
    };
  }
};
