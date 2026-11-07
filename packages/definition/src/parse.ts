import { isAlias, isMap, isNode, isSeq, LineCounter, parseDocument, visit } from "yaml";
import type { z } from "zod";

import { definitionSchema } from "./schema.js";
import type { Definition } from "./schema.js";

/** A problem found while parsing a workflow definition. */
export interface ParseError {
  /** Path of the invalid value in the definition. */
  path: (number | string)[];
  /** One-based line number in the source. */
  line: number;
  /** One-based column number in the source. */
  column: number;
  message: string;
}

/** Result of {@link parseDefinition}. */
export type ParseResult =
  | { ok: true; definition: Definition }
  | { ok: false; errors: ParseError[] };

type DefinitionDocument = ReturnType<typeof parseDocument>;

function createError(
  lineCounter: LineCounter,
  offset: number,
  path: (number | string)[],
  message: string,
): ParseError {
  const { col: column, line } = lineCounter.linePos(offset);
  return { column, line, message, path };
}

function findAliasErrors(document: DefinitionDocument, lineCounter: LineCounter): ParseError[] {
  const errors: ParseError[] = [];

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
}

/** Finds the source offset of a path, falling back to its closest existing parent. */
function findOffset(
  document: DefinitionDocument,
  path: readonly (number | string)[],
  useKey: boolean,
): number {
  let node: unknown = document.contents;
  let offset = isNode(node) ? (node.range?.[0] ?? 0) : 0;

  for (const [index, segment] of path.entries()) {
    if (isMap(node)) {
      const pair = node.items.find(
        ({ key }) => isNode(key) && "value" in key && key.value === segment,
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
}

function toPath(path: readonly PropertyKey[]): (number | string)[] {
  return path.filter((segment) => typeof segment !== "symbol");
}

function convertIssue(
  issue: z.core.$ZodIssue,
  document: DefinitionDocument,
  lineCounter: LineCounter,
): ParseError[] {
  const path = toPath(issue.path);

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
  return [createError(lineCounter, offset, path, issue.message)];
}

/**
 * Parses and validates a YAML workflow definition.
 *
 * Invalid definitions are reported in the result instead of being thrown.
 */
export function parseDefinition(source: string): ParseResult {
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

  const result = definitionSchema.safeParse(document.toJS() as unknown);
  if (!result.success) {
    return {
      errors: result.error.issues.flatMap((issue) => convertIssue(issue, document, lineCounter)),
      ok: false,
    };
  }

  return { definition: result.data, ok: true };
}
