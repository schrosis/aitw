import { validateIntermediate } from "@aitw/core";
import type { Intermediate } from "@aitw/core";

import { buildIntermediate, toDefinitionPath } from "./build.js";
import { parseDefinition } from "./parse.js";
import type { DefinitionError } from "./parse.js";

/** Result of {@link compileDefinition}. */
export type CompileResult =
  | { ok: true; intermediate: Intermediate }
  | { ok: false; errors: DefinitionError[] };

/**
 * Parses, builds, and validates a YAML workflow definition.
 *
 * Errors in the intermediate representation are reported at their YAML locations.
 */
export const compileDefinition = (source: string): CompileResult => {
  const parsed = parseDefinition(source);
  if (!parsed.ok) {
    return parsed;
  }

  const validation = validateIntermediate(buildIntermediate(parsed.definition));
  if (!validation.ok) {
    return {
      errors: validation.errors.map(({ message, path }) => {
        const definitionPath = toDefinitionPath(path);
        // A whole step is reported at its ID.
        const key = definitionPath.length === 2 && definitionPath[0] === "steps";
        return { ...parsed.locate(definitionPath, { key }), message, path: definitionPath };
      }),
      ok: false,
    };
  }

  return { intermediate: validation.intermediate, ok: true };
};
