import { parseTemplate } from "./template.js";
import type { Template } from "./template.js";

/** Result of {@link evaluateTemplate}. */
export type EvaluateResult = { ok: true; value: unknown } | { ok: false; message: string };

type Resolved = { ok: true; value: unknown } | { ok: false };

const resolve = (context: Readonly<Record<string, unknown>>, path: readonly string[]): Resolved => {
  let value: unknown = context;
  for (const segment of path) {
    // Only own data properties are read, so that references cannot reach prototype members
    // or run getters.
    const descriptor =
      typeof value === "object" && value !== null
        ? Object.getOwnPropertyDescriptor(value, segment)
        : undefined;
    if (descriptor === undefined || !("value" in descriptor)) {
      return { ok: false };
    }
    const next: unknown = descriptor.value;
    value = next;
  }
  return { ok: true, value };
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
 * Returns the part of a context that the `${{ }}` references in some strings read.
 *
 * It keeps only the referenced values, so that a step receives what its definition uses and
 * not every value that the workflow holds.
 *
 * @param roots Names of the top-level context entries to pick from. Other references are left
 *   out, such as references to values that are not known yet.
 */
export const pickReferences = (
  texts: readonly string[],
  context: Readonly<Record<string, unknown>>,
  roots: ReadonlySet<string>,
): Tree => {
  const picked: Tree = {};
  for (const text of texts) {
    const parsed = parseTemplate(text);
    if (!parsed.ok) {
      continue;
    }
    for (const part of parsed.template) {
      if (part.type !== "reference" || !roots.has(part.path[0] ?? "")) {
        continue;
      }
      const resolved = resolve(context, part.path);
      if (resolved.ok) {
        setPath(picked, part.path, resolved.value);
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
 * Evaluates a parsed template against the values that its references may read.
 *
 * A template that consists of a single reference keeps the type of the value. Otherwise the
 * values are embedded into a string.
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
    const resolved = resolve(context, part.path);
    if (!resolved.ok) {
      return { message: `Unknown reference: ${part.source}`, ok: false };
    }
    values.push(resolved.value);
  }

  const [only] = template;
  if (template.length === 1 && only?.type === "reference") {
    return { ok: true, value: values[0] };
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
