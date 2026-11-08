import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { ValidationError } from "../intermediate/index.js";

/** Result of {@link validateWithSchema}. */
export type SchemaResult<Output> =
  | { ok: true; value: Output }
  | { ok: false; errors: ValidationError[] };

const toPathSegment = (
  segment: PropertyKey | StandardSchemaV1.PathSegment,
): number | string | undefined => {
  const key = typeof segment === "object" ? segment.key : segment;
  return typeof key === "symbol" ? undefined : key;
};

/**
 * Validates a value with a Standard Schema, such as a Zod schema of a plugin.
 *
 * Definitions are validated synchronously, so a schema that validates asynchronously is reported
 * as an error. A schema that throws, such as for a bug in a plugin, is also reported as an error.
 *
 * The paths of the errors are relative to the value. Callers prefix them with the location of
 * the value, such as `["steps", id, "with"]`.
 */
export const validateWithSchema = <Output>(
  schema: StandardSchemaV1<unknown, Output>,
  value: unknown,
): SchemaResult<Output> => {
  let result: StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>;
  try {
    result = schema["~standard"].validate(value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { errors: [{ message: `The schema failed: ${reason}`, path: [] }], ok: false };
  }
  if (result instanceof Promise) {
    // The promise is not awaited, so a rejection must not become unhandled.
    result.catch(() => {});
    return {
      errors: [
        { message: "The schema validates asynchronously, which is not supported", path: [] },
      ],
      ok: false,
    };
  }
  if (result.issues !== undefined) {
    return {
      errors: result.issues.map(({ message, path = [] }) => ({
        message,
        path: path.map(toPathSegment).filter((segment) => segment !== undefined),
      })),
      ok: false,
    };
  }
  return { ok: true, value: result.value };
};
