/** Result of a call of a helper. */
export type HelperResult = { ok: true; value: unknown } | { ok: false; message: string };

/** A function that `${{ }}` expressions can call. */
export interface Helper {
  /** Fewest and most arguments that it takes. */
  readonly arity: Readonly<{ min: number; max: number }>;
  /**
   * Returns the value of a call. It must be pure and deterministic, because workflow code
   * evaluates expressions, and validation calls it with literal arguments.
   */
  readonly call: (args: readonly unknown[]) => HelperResult;
}

/** Returns the type of a value for messages: null, string, number, boolean, array, or object. */
export const describeType = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

/**
 * Removes the white space and line terminators at the start and the end of a string, as
 * `String.prototype.trim` does. It fails on any other value, including `null`, rather than
 * converting it.
 */
export const trim: Helper = {
  arity: { max: 1, min: 1 },
  call: ([value]) =>
    typeof value === "string"
      ? { ok: true, value: value.trim() }
      : { message: `trim expects a string but got ${describeType(value)}`, ok: false },
};

/** Helpers that every expression can call, by name. */
export const builtinHelpers: ReadonlyMap<string, Helper> = new Map([["trim", trim]]);
