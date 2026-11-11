import { isAlias, isMap, isNode, isScalar, isSeq, LineCounter, parseDocument, visit } from "yaml";
import { decimalNumberMessage, decimalNumberPattern } from "@aitw/core";
import type { z } from "zod";

import { definitionSchema } from "./schema.js";
import type { Definition } from "./schema.js";

/** A problem found in a workflow definition. */
export interface DefinitionError {
  /** Path of the invalid value in the definition. */
  path: (number | string)[];
  /** One-based line number in the source. */
  line: number;
  /** One-based column number in the source. */
  column: number;
  message: string;
}

/** Finds the source position of a definition path. */
export type DefinitionLocator = (
  path: readonly (number | string)[],
  options?: { key?: boolean },
) => { line: number; column: number };

/** Result of {@link parseDefinition}. */
export type ParseResult =
  | { ok: true; definition: Definition; locate: DefinitionLocator }
  | { ok: false; errors: DefinitionError[] };

type DefinitionDocument = ReturnType<typeof parseDocument>;

const createError = (
  lineCounter: LineCounter,
  offset: number,
  path: (number | string)[],
  message: string,
): DefinitionError => {
  const { col: column, line } = lineCounter.linePos(offset);
  return { column, line, message, path };
};

const findAliasErrors = (
  document: DefinitionDocument,
  lineCounter: LineCounter,
): DefinitionError[] => {
  const errors: DefinitionError[] = [];

  visit(document, (_key, node) => {
    if (!isNode(node)) {
      return;
    }
    const offset = node.range?.[0] ?? 0;
    if (isAlias(node)) {
      errors.push(createError(lineCounter, offset, [], "YAML aliases are not supported"));
    } else if (node.anchor !== undefined) {
      errors.push(createError(lineCounter, offset, [], "YAML anchors are not supported"));
    }
  });

  return errors;
};

/**
 * Finds defaults of number inputs written in a notation other than plain decimals.
 *
 * YAML also reads numbers such as `1e3`, `0x10`, and `.inf`, which the parsed value no longer
 * shows.
 */
const findNumberNotationErrors = (
  document: DefinitionDocument,
  lineCounter: LineCounter,
): DefinitionError[] => {
  const inputs = isMap(document.contents) ? document.contents.get("inputs") : undefined;
  if (!isMap(inputs)) {
    return [];
  }
  return inputs.items.flatMap(({ key, value }): DefinitionError[] => {
    if (!isMap(value) || value.get("type") !== "number") {
      return [];
    }
    const defaultValue = value.get("default", true);
    if (
      !isScalar(key) ||
      !isScalar(defaultValue) ||
      typeof defaultValue.value !== "number" ||
      decimalNumberPattern.test(defaultValue.source ?? "")
    ) {
      return [];
    }
    return [
      createError(
        lineCounter,
        defaultValue.range?.[0] ?? 0,
        ["inputs", String(key.value), "default"],
        decimalNumberMessage,
      ),
    ];
  });
};

/** Finds the source offset of a path, falling back to its closest existing parent. */
const findOffset = (
  document: DefinitionDocument,
  path: readonly (number | string)[],
  useKey: boolean,
): number => {
  let node: unknown = document.contents;
  let offset = isNode(node) ? (node.range?.[0] ?? 0) : 0;

  for (const [index, segment] of path.entries()) {
    if (isMap(node)) {
      const pair = node.items.find(
        ({ key }) => isScalar(key) && String(key.value) === String(segment),
      );
      if (pair === undefined) {
        break;
      }
      node = pair.value;
      const target = useKey && index === path.length - 1 ? pair.key : pair.value;
      offset = isNode(target) ? (target.range?.[0] ?? offset) : offset;
    } else if (isSeq(node) && typeof segment === "number") {
      node = node.items[segment];
      offset = isNode(node) ? (node.range?.[0] ?? offset) : offset;
    } else {
      break;
    }
  }

  return offset;
};

const toPath = (path: readonly PropertyKey[]): (number | string)[] => {
  return path.filter((segment) => typeof segment !== "symbol");
};

const convertIssue = (
  issue: z.core.$ZodIssue,
  document: DefinitionDocument,
  lineCounter: LineCounter,
): DefinitionError[] => {
  const path = toPath(issue.path);

  // A value that has the type of one option of a union is reported with the problems of that
  // option, such as an unknown field of a branch.
  if (issue.code === "invalid_union") {
    const option = issue.errors.find(
      (issues) => !issues.some((inner) => inner.code === "invalid_type" && inner.path.length === 0),
    );
    if (option !== undefined) {
      return option.flatMap((inner) =>
        convertIssue({ ...inner, path: [...issue.path, ...inner.path] }, document, lineCounter),
      );
    }
  }

  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => {
      const keyPath = [...path, key];
      return createError(
        lineCounter,
        findOffset(document, keyPath, true),
        keyPath,
        `Unknown field: ${key}`,
      );
    });
  }

  const offset = findOffset(document, path, issue.code === "invalid_key");
  // An invalid key of a record explains itself in its first nested issue, such as the pattern
  // that a name must match.
  const message =
    issue.code === "invalid_key" ? (issue.issues[0]?.message ?? issue.message) : issue.message;
  return [createError(lineCounter, offset, path, message)];
};

/** Result of {@link parseYaml}. */
export type YamlParseResult<Value> =
  | { ok: true; value: Value; locate: DefinitionLocator }
  | { ok: false; errors: DefinitionError[] };

/**
 * Parses a YAML document and validates it with a schema, reporting problems with their source
 * positions.
 *
 * Aliases and anchors are rejected, because the positions of the values that they repeat would
 * be unclear. An empty document is `null`.
 *
 * @param check Finds problems that the parsed value no longer shows, such as how a number was
 *   written. A value whose path it reports is not reported by the schema again.
 */
export const parseYaml = <Schema extends z.ZodType>(
  source: string,
  schema: Schema,
  check: (document: DefinitionDocument, lineCounter: LineCounter) => DefinitionError[] = () => [],
): YamlParseResult<z.output<Schema>> => {
  const lineCounter = new LineCounter();
  const document = parseDocument(source, { lineCounter, prettyErrors: false });

  const syntaxErrors = document.errors.map((error) =>
    createError(lineCounter, error.pos[0], [], error.message),
  );
  if (syntaxErrors.length > 0) {
    return { errors: syntaxErrors, ok: false };
  }

  const aliasErrors = findAliasErrors(document, lineCounter);
  if (aliasErrors.length > 0) {
    return { errors: aliasErrors, ok: false };
  }

  const checkErrors = check(document, lineCounter);
  const result = schema.safeParse(document.toJS() as unknown);
  if (!result.success || checkErrors.length > 0) {
    return {
      errors: [
        ...checkErrors,
        ...(
          result.error?.issues.flatMap((issue) => convertIssue(issue, document, lineCounter)) ?? []
        ).filter(
          ({ path }) => !checkErrors.some((error) => error.path.join(".") === path.join(".")),
        ),
      ],
      ok: false,
    };
  }

  const locate: DefinitionLocator = (path, options = {}) => {
    const { col: column, line } = lineCounter.linePos(
      findOffset(document, path, options.key ?? false),
    );
    return { column, line };
  };

  return { locate, ok: true, value: result.data };
};

/**
 * Parses a YAML workflow definition and validates its structure.
 *
 * Invalid definitions are reported in the result instead of being thrown.
 */
export const parseDefinition = (source: string): ParseResult => {
  // A number notation error explains why its value fails the schema.
  const result = parseYaml(source, definitionSchema, findNumberNotationErrors);
  return result.ok
    ? { definition: result.value, locate: result.locate, ok: true }
    : { errors: result.errors, ok: false };
};
