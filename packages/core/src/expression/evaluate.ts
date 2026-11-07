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

/**
 * Converts a value to the string that a template embeds.
 *
 * Strings are kept as they are, and objects and arrays are converted to JSON.
 *
 * @throws When the value cannot be converted to JSON, such as a BigInt.
 */
export const embedValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
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
