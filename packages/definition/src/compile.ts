import { createPluginRegistry, validateIntermediate, validateWithSchema } from "@aitw/core";
import type { Intermediate, PluginRegistry, ValidationError } from "@aitw/core";

import { buildIntermediate, toDefinitionPath } from "./build.js";
import type { WaitAnswers } from "./build.js";
import { parseDefinition } from "./parse.js";
import type { DefinitionError } from "./parse.js";
import type { Definition } from "./schema.js";

/** Result of {@link compileDefinition}. */
export type CompileResult =
  | { ok: true; intermediate: Intermediate }
  | { ok: false; errors: DefinitionError[] };

/** Options of {@link compileDefinition}. */
export interface CompileOptions {
  /** Plugins that provide the methods of wait steps. Without it, no method is available. */
  plugins?: PluginRegistry;
}

/**
 * Validates the method and `with` of every wait step, and collects the answers that the
 * methods describe.
 *
 * The paths of the errors are definition paths.
 */
const resolveWaitSteps = (
  definition: Definition,
  plugins: PluginRegistry,
): { answers: WaitAnswers; errors: ValidationError[] } => {
  const answers: Record<string, WaitAnswers[string]> = {};
  const errors: ValidationError[] = [];
  for (const [id, step] of Object.entries(definition.steps)) {
    if (step.type !== "wait") {
      continue;
    }
    const method = plugins.waitMethod(step.method);
    if (method === undefined) {
      const names = plugins.waitMethodNames();
      errors.push({
        message: `Unknown wait method: ${step.method}. ${
          names.length > 0 ? `Available methods: ${names.join(", ")}` : "No methods are available"
        }`,
        path: ["steps", id, "method"],
      });
      continue;
    }
    const options = validateWithSchema(method.with, step.with ?? {});
    if (!options.ok) {
      errors.push(
        ...options.errors.map(({ message, path }) => ({
          message,
          path: ["steps", id, "with", ...path],
        })),
      );
      continue;
    }
    answers[id] = method.answers?.(options.value);
  }
  return { answers, errors };
};

/**
 * Parses, builds, and validates a YAML workflow definition.
 *
 * Errors in the intermediate representation are reported at their YAML locations.
 */
export const compileDefinition = (
  source: string,
  { plugins = createPluginRegistry() }: CompileOptions = {},
): CompileResult => {
  const parsed = parseDefinition(source);
  if (!parsed.ok) {
    return parsed;
  }

  const waits = resolveWaitSteps(parsed.definition, plugins);
  const validation = validateIntermediate(buildIntermediate(parsed.definition, waits.answers));
  const errors = [
    ...waits.errors,
    ...(validation.ok
      ? []
      : validation.errors.map(({ message, path }) => ({ message, path: toDefinitionPath(path) }))),
  ];
  if (errors.length > 0 || !validation.ok) {
    return {
      errors: errors.map(({ message, path }) => {
        // A whole step is reported at its ID.
        const key = path.length === 2 && path[0] === "steps";
        return { ...parsed.locate(path, { key }), message, path };
      }),
      ok: false,
    };
  }

  return { intermediate: validation.intermediate, ok: true };
};
