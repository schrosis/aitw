import type { InputDeclaration } from "./schema.js";
import type { ValidationError } from "./validate.js";

/**
 * Text of a number that a workflow input accepts, such as `-1.5`.
 *
 * Exponent notation such as `1e3` is not accepted, so that a value reads as written.
 */
export const decimalNumberPattern = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;

/** Message for a number that does not match {@link decimalNumberPattern}. */
export const decimalNumberMessage =
  "Must be a decimal number such as 1.5, without exponent notation";

/** Values of the workflow input after defaults are applied, keyed by name. */
export type WorkflowInput = Record<string, boolean | number | string | null>;

/** Result of {@link resolveWorkflowInput}. */
export type ResolveInputResult =
  | { ok: true; input: WorkflowInput }
  | { ok: false; errors: ValidationError[] };

type CheckResult = { ok: true; value: boolean | number | string } | { ok: false; message: string };

/** Checks that a value matches its declaration. */
export const checkInputValue = (declaration: InputDeclaration, value: unknown): CheckResult => {
  if (declaration.type === "string") {
    return typeof value === "string"
      ? { ok: true, value }
      : { message: "Must be a string", ok: false };
  }
  if (declaration.type === "number") {
    return typeof value === "number" && Number.isFinite(value)
      ? { ok: true, value }
      : { message: "Must be a finite number", ok: false };
  }
  if (declaration.type === "boolean") {
    return typeof value === "boolean"
      ? { ok: true, value }
      : { message: "Must be a boolean", ok: false };
  }
  return typeof value === "string" && declaration.options.includes(value)
    ? { ok: true, value }
    : { message: `Must be one of ${declaration.options.join(", ")}`, ok: false };
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Validates the values that start a workflow and applies the defaults.
 *
 * An optional input without a default becomes `null` when it is not given.
 */
export const resolveWorkflowInput = (
  declarations: Readonly<Record<string, InputDeclaration>>,
  values: unknown,
): ResolveInputResult => {
  if (!isRecord(values)) {
    return { errors: [{ message: "Must be an object", path: [] }], ok: false };
  }

  const errors: ValidationError[] = [];
  for (const name of Object.keys(values)) {
    if (!Object.hasOwn(declarations, name)) {
      errors.push({ message: "Unknown input", path: [name] });
    }
  }

  const input: WorkflowInput = {};
  for (const [name, declaration] of Object.entries(declarations)) {
    if (!Object.hasOwn(values, name)) {
      if (declaration.required) {
        errors.push({ message: "Required", path: [name] });
      }
      input[name] = declaration.default ?? null;
      continue;
    }
    const checked = checkInputValue(declaration, values[name]);
    if (checked.ok) {
      input[name] = checked.value;
    } else {
      errors.push({ message: checked.message, path: [name] });
    }
  }

  return errors.length > 0 ? { errors, ok: false } : { input, ok: true };
};
