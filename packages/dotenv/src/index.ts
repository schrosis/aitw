import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { envNamePattern } from "@ugoke/core";

/** A line of a dotenv file that cannot be read. */
export interface DotenvError {
  /** One-based line number. */
  line: number;
  /** Why the line cannot be read. It never contains the name or the value. */
  message: string;
}

/** Result of {@link parseDotenv}. */
export type ParseDotenvResult =
  | { ok: true; values: Record<string, string> }
  | { ok: false; errors: DotenvError[] };

// The messages never contain the name or the value, since a value may be a secret and the name
// of a malformed line is unknown.
const messages = {
  assignment: "Expected NAME=value",
  backquote: "Quote a value with single or double quotes, not backquotes",
  backslash: 'Only \\n can follow \\ in double quotes. Use single quotes for a value with \\ or "',
  comment: "A # must follow a space to start a comment. Quote a value that contains #",
  duplicate: (line: number) => `The name is already set on line ${line}`,
  name: "Names must start with a letter or _ and contain only letters, digits, or _",
  textAfterQuote: "Unexpected text after the closing quote",
  unterminated: (quote: string) => `The value has no closing ${quote}`,
} as const;

/** Whitespace of a dotenv file, which is only spaces and tabs. */
const isBlank = (character: string | undefined): boolean => character === " " || character === "\t";

const trimBlanks = (text: string): string => text.replace(/^[ \t]+|[ \t]+$/gu, "");

const isBlankOrComment = (text: string): boolean => {
  const content = trimBlanks(text);
  return content === "" || content.startsWith("#");
};

/** A quoted value and where its closing quote is. */
interface QuotedValue {
  value: string;
  /** Zero-based index of the line of the closing quote. */
  end: number;
  /** Text after the closing quote on its line. */
  rest: string;
  /** One-based line number of the first backslash that is not allowed, if any. */
  badEscape?: number;
}

/**
 * Reads a value in quotes that opens at `column` of `lines[start]`, which may span lines.
 *
 * A backslash that is not allowed is returned instead of reported, so that nothing is reported
 * from the lines after a quote that is never closed.
 *
 * @returns `undefined` when the quote is never closed.
 */
const readQuoted = (
  lines: readonly string[],
  start: number,
  column: number,
): QuotedValue | undefined => {
  const quote = lines[start]?.[column];
  let row = start;
  let position = column + 1;
  let value = "";
  let badEscape: number | undefined;
  for (;;) {
    const line = lines[row];
    if (line === undefined) {
      return undefined;
    }
    const character = line[position];
    if (character === undefined) {
      // The line break is a part of the value.
      value += "\n";
      row += 1;
      position = 0;
    } else if (character === quote) {
      const quoted: QuotedValue = { end: row, rest: line.slice(position + 1), value };
      return badEscape === undefined ? quoted : { ...quoted, badEscape };
    } else if (quote === '"' && character === "\\") {
      if (line[position + 1] === "n") {
        value += "\n";
      } else {
        badEscape ??= row + 1;
      }
      // The escaped character is skipped even when it is not allowed, so that `"a\"b"` does not
      // end at the escaped quote and shift the lines after it.
      if (position + 1 < line.length) {
        position += 2;
      } else {
        row += 1;
        position = 0;
      }
    } else {
      value += character;
      position += 1;
    }
  }
};

/** Reads a value without quotes that starts at `column` of `line`, and drops a comment. */
const readUnquoted = (
  line: string,
  number: number,
  column: number,
  errors: DotenvError[],
): string => {
  const hash = line.indexOf("#", column);
  if (hash === -1) {
    return trimBlanks(line.slice(column));
  }
  if (!isBlank(line[hash - 1])) {
    errors.push({ line: number, message: messages.comment });
  }
  return trimBlanks(line.slice(column, hash));
};

/**
 * Parses the text of a dotenv file in the format that ugoke supports.
 *
 * A byte order mark at the start is skipped, and lines may end with LF or CRLF. Each line is
 * blank, a comment that starts with `#`, or an assignment `NAME=value`, optionally prefixed with
 * `export`. Names must match the names of `env` in definitions. A value is either:
 *
 * - Unquoted, with the surrounding whitespace removed. A `#` after whitespace starts a comment.
 * - In single quotes, taken as written.
 * - In double quotes, where `\n` is a line break and no other backslash is allowed.
 *
 * Quoted values may span lines, and only whitespace and a comment may follow them. Variables such
 * as `$HOME` are not expanded.
 *
 * Every malformed line is reported, and no values are returned when there is any. The text after a
 * quote that is never closed is not read, since where its lines start is unknown.
 */
export const parseDotenv = (text: string): ParseDotenvResult => {
  const lines = (text.startsWith("\uFEFF") ? text.slice(1) : text)
    .replaceAll("\r\n", "\n")
    .split("\n");
  const errors: DotenvError[] = [];
  // A map keeps a name such as `__proto__` from changing the prototype of the values.
  const values = new Map<string, string>();
  const assignedOn = new Map<string, number>();
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const number = index + 1;
    index += 1;
    if (isBlankOrComment(line)) {
      continue;
    }
    const equals = line.indexOf("=");
    if (equals === -1) {
      errors.push({ line: number, message: messages.assignment });
      continue;
    }
    const name = trimBlanks(line.slice(0, equals)).replace(/^export[ \t]+/u, "");
    const valid = envNamePattern.test(name);
    const assigned = assignedOn.get(name);
    if (!valid) {
      errors.push({ line: number, message: messages.name });
    } else if (assigned === undefined) {
      assignedOn.set(name, number);
    } else {
      errors.push({ line: number, message: messages.duplicate(assigned) });
    }

    let column = equals + 1;
    while (isBlank(line[column])) {
      column += 1;
    }
    const quote = line[column];
    if (quote === "`") {
      errors.push({ line: number, message: messages.backquote });
      continue;
    }
    let value: string;
    if (quote === "'" || quote === '"') {
      const quoted = readQuoted(lines, index - 1, column);
      if (quoted === undefined) {
        errors.push({ line: number, message: messages.unterminated(quote) });
        break;
      }
      if (quoted.badEscape !== undefined) {
        errors.push({ line: quoted.badEscape, message: messages.backslash });
      }
      if (!isBlankOrComment(quoted.rest)) {
        errors.push({ line: quoted.end + 1, message: messages.textAfterQuote });
      }
      index = quoted.end + 1;
      ({ value } = quoted);
    } else {
      value = readUnquoted(line, number, column, errors);
    }
    if (valid && assigned === undefined) {
      values.set(name, value);
    }
  }
  return errors.length === 0
    ? { ok: true, values: Object.fromEntries(values) }
    : { errors, ok: false };
};

/** Result of {@link readDotenv}. */
export type DotenvResult =
  | { ok: true; values: NodeJS.Dict<string> }
  | { ok: false; message: string };

/**
 * Reads a dotenv file, relative to the working directory.
 *
 * The file is read in the format of {@link parseDotenv}, and is not read at all when any line is
 * malformed. It is read each time a step runs, so its values never enter the workflow history. A
 * file that a symbolic link puts outside of the working directory is not read.
 */
export const readDotenv = (cwd: string, path: string): DotenvResult => {
  const failure = (reason: string): DotenvResult => ({
    message: `Failed to read the dotenv file ${path}: ${reason}`,
    ok: false,
  });
  let file: string;
  try {
    const root = realpathSync(cwd);
    file = realpathSync(resolve(cwd, path));
    const inside = relative(root, file);
    // Segments are compared, so that a file such as ..env in the root is inside.
    if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      return failure("it is outside of the project root");
    }
    const parsed = parseDotenv(readFileSync(file, "utf8"));
    if (!parsed.ok) {
      return failure(
        parsed.errors.map(({ line, message }) => `line ${line}: ${message}`).join("; "),
      );
    }
    return { ok: true, values: parsed.values };
  } catch (error) {
    // The reason is kept in the message, so that it is reported with the step.
    return failure(error instanceof Error ? error.message : String(error));
  }
};

/**
 * Returns the environment that a step sees besides the variables of its definition, which take
 * precedence over it.
 *
 * Inherited variables take precedence over the dotenv file. Scripts, AI steps, and conditions all
 * use it, so that they see the same values.
 */
export const readEnvironment = (cwd: string, dotenv: string | undefined): DotenvResult => {
  if (dotenv === undefined) {
    return { ok: true, values: { ...process.env } };
  }
  const file = readDotenv(cwd, dotenv);
  return file.ok ? { ok: true, values: { ...file.values, ...process.env } } : file;
};
