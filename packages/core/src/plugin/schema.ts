import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";

import type { ValidationError } from "../intermediate/index.js";
import type { Plugin } from "./types.js";

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

/**
 * Validates the settings that a project writes for a plugin, with the `config` schema of the
 * plugin.
 *
 * A plugin without the schema takes no settings, so only an absent or empty value passes.
 *
 * @param settings The value under the package name, or `null` when nothing is written.
 */
export const validatePluginConfig = (
  plugin: Pick<Plugin, "config">,
  settings: unknown,
): SchemaResult<unknown> => {
  if (plugin.config === undefined) {
    const empty =
      settings === null ||
      settings === undefined ||
      (typeof settings === "object" && Object.keys(settings).length === 0);
    return empty
      ? { ok: true, value: undefined }
      : { errors: [{ message: "The plugin takes no settings", path: [] }], ok: false };
  }
  // A plugin with settings receives an empty object when nothing is written.
  return validateWithSchema(plugin.config, settings ?? {});
};

/** Version of JSON Schema that ugoke generates, which editors for YAML support widely. */
export const jsonSchemaTarget = "draft-07";

/** An object of JSON, such as a JSON Schema. */
export type JsonObject = Record<string, unknown>;

/** Returns whether a value is an object of JSON, and not an array or `null`. */
export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasJsonSchema = (
  standard: StandardSchemaV1.Props,
): standard is StandardSchemaV1.Props & StandardJSONSchemaV1.Props =>
  "jsonSchema" in standard &&
  typeof standard.jsonSchema === "object" &&
  standard.jsonSchema !== null &&
  "input" in standard.jsonSchema &&
  typeof standard.jsonSchema.input === "function";

/**
 * Converts the input of a schema of a plugin to JSON Schema, such as for editors.
 *
 * It uses Standard JSON Schema, which libraries such as Zod implement.
 *
 * @returns The JSON Schema without `$schema`, or `undefined` when the schema cannot be converted.
 */
export const toJsonSchema = (schema: StandardSchemaV1): Record<string, unknown> | undefined => {
  const standard = schema["~standard"];
  if (!hasJsonSchema(standard)) {
    return undefined;
  }
  try {
    const { $schema: _version, ...converted } = standard.jsonSchema.input({
      target: jsonSchemaTarget,
    });
    return converted;
  } catch {
    // A library may not convert every schema, such as one with a custom check.
    return undefined;
  }
};
