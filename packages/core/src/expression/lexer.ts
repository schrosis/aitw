import { identifierSource } from "../identifier.js";

/** A problem in an expression. The parsers and evaluators report it as a result. */
export class ExpressionError extends Error {}

const operators = ["==", "!=", "&&", "||", "!", "(", ")"] as const;

/** An operator of an expression. */
export type Operator = (typeof operators)[number];

const isOperator = (value: string): value is Operator =>
  (operators as readonly string[]).includes(value);

const operatorSource = operators
  .map((operator) => operator.replaceAll(/[|()]/gu, String.raw`\$&`))
  .join("|");

/** A token of an expression. */
export type Token =
  | { kind: "operator"; value: Operator }
  | { kind: "literal"; value: boolean | number | string | null }
  | { kind: "reference"; path: string[] };

/** Which names a reference can have. Conditions also accept names that start with `_`. */
export type ReferenceNames = "template" | "condition";

/** Splits the indexes off the segments of a path, such as `visits[0]` into `visits` and `0`. */
export const expandIndexes = (segments: readonly string[]): string[] =>
  segments.flatMap((segment) => {
    const match = /^(?<name>[^[\]]+)\[(?<index>\d+)\]$/u.exec(segment);
    return match?.groups?.name !== undefined && match.groups.index !== undefined
      ? [match.groups.name, match.groups.index]
      : [segment];
  });

/** Returns the source of a pattern of a path of names, each of which can have an index. */
const pathSource = (name: string): string => `${name}(?:\\[\\d+\\])?(?:\\.${name}(?:\\[\\d+\\])?)*`;

const nameSources: Readonly<Record<ReferenceNames, string>> = {
  // Names can start with _, unlike those of a template, because environment variables can.
  condition: "[A-Za-z_][A-Za-z0-9_]*",
  template: identifierSource,
};

const createTokenPattern = (names: ReferenceNames): RegExp =>
  new RegExp(
    String.raw`\s*(?:(?<operator>${operatorSource})|'(?<text>(?:[^']|'')*)'|(?<number>-?\d+(?:\.\d+)?)|(?<name>${pathSource(nameSources[names])}))`,
    "uy",
  );

const tokenPatterns: Readonly<Record<ReferenceNames, RegExp>> = {
  condition: createTokenPattern("condition"),
  template: createTokenPattern("template"),
};

const keywords: ReadonlyMap<string, boolean | null> = new Map([
  ["false", false],
  ["null", null],
  ["true", true],
]);

/**
 * Splits an expression into tokens.
 *
 * @param names Which names a reference can have.
 * @throws ExpressionError on text that is not a token.
 */
export const tokenize = (expression: string, names: ReferenceNames): Token[] => {
  const tokenPattern = tokenPatterns[names];
  const tokens: Token[] = [];
  const end = expression.trimEnd().length;
  tokenPattern.lastIndex = 0;
  while (tokenPattern.lastIndex < end) {
    const position = tokenPattern.lastIndex;
    const groups = tokenPattern.exec(expression)?.groups;
    if (groups === undefined) {
      throw new ExpressionError(`Unexpected text: ${expression.slice(position).trim()}`);
    }
    const { name, number, operator, text } = groups;
    if (operator !== undefined && isOperator(operator)) {
      tokens.push({ kind: "operator", value: operator });
    } else if (text !== undefined) {
      tokens.push({ kind: "literal", value: text.replaceAll("''", "'") });
    } else if (number !== undefined) {
      tokens.push({ kind: "literal", value: Number(number) });
    } else if (name !== undefined) {
      const keyword = keywords.get(name);
      tokens.push(
        keyword === undefined
          ? { kind: "reference", path: expandIndexes(name.split(".")) }
          : { kind: "literal", value: keyword },
      );
    }
  }
  return tokens;
};
