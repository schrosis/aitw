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
  /** Plugins that provide wait methods and AI providers. Without it, none is available. */
  plugins?: PluginRegistry;
  /**
   * Returns how to get a wait method or an AI provider that no plugin provides, such as which
   * package to install. It replaces the list of the available names in the message.
   */
  missingHint?: MissingHint;
}

/** Returns how to get an extension that no plugin provides, or `undefined` when unknown. */
export type MissingHint = (kind: "aiProvider" | "waitMethod", name: string) => string | undefined;

/**
 * Validates the method and `with` of every wait step, and collects the answers that the
 * methods describe.
 *
 * The paths of the errors are definition paths.
 */
const resolveWaitSteps = (
  definition: Definition,
  plugins: PluginRegistry,
  missingHint: MissingHint,
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
          missingHint("waitMethod", step.method) ??
          (names.length > 0 ? `Available methods: ${names.join(", ")}` : "No methods are available")
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
    // A bug in a plugin is reported at the step instead of stopping the command.
    try {
      answers[id] = method.answers?.(options.value, plugins.waitMethodConfig(step.method));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      errors.push({
        message: `Wait method ${step.method} failed to describe its answers: ${reason}`,
        path: ["steps", id, "with"],
      });
    }
  }
  return { answers, errors };
};

/**
 * Validates the provider and `with` of every AI step.
 *
 * The paths of the errors are definition paths.
 */
const checkAiSteps = (
  definition: Definition,
  plugins: PluginRegistry,
  missingHint: MissingHint,
): ValidationError[] =>
  Object.entries(definition.steps).flatMap(([id, step]): ValidationError[] => {
    if (step.type !== "ai") {
      return [];
    }
    const provider = plugins.aiProvider(step.provider);
    if (provider === undefined) {
      const names = plugins.aiProviderNames();
      return [
        {
          message: `Unknown AI provider: ${step.provider}. ${
            missingHint("aiProvider", step.provider) ??
            (names.length > 0
              ? `Available providers: ${names.join(", ")}`
              : "No providers are available")
          }`,
          path: ["steps", id, "provider"],
        },
      ];
    }
    const options = validateWithSchema(provider.with, step.with ?? {});
    return options.ok
      ? []
      : options.errors.map(({ message, path }) => ({
          message,
          path: ["steps", id, "with", ...path],
        }));
  });

/**
 * Parses, builds, and validates a YAML workflow definition.
 *
 * Errors in the intermediate representation are reported at their YAML locations.
 */
export const compileDefinition = (
  source: string,
  { missingHint = () => undefined, plugins = createPluginRegistry() }: CompileOptions = {},
): CompileResult => {
  const parsed = parseDefinition(source);
  if (!parsed.ok) {
    return parsed;
  }

  const waits = resolveWaitSteps(parsed.definition, plugins, missingHint);
  const validation = validateIntermediate(buildIntermediate(parsed.definition, waits.answers));
  const errors = [
    ...waits.errors,
    ...checkAiSteps(parsed.definition, plugins, missingHint),
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
