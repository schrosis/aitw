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
 * as an error.
 */
export const validateWithSchema = <Output>(
  schema: StandardSchemaV1<unknown, Output>,
  value: unknown,
): SchemaResult<Output> => {
  const result = schema["~standard"].validate(value);
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
