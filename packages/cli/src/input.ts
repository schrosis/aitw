import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { decimalNumberMessage, decimalNumberPattern } from "@aitw/core";

/** Result of {@link readWorkflowInput}. */
export type ReadInputResult =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; message: string };

/** A number in exponent notation, found while parsing JSON. */
class NumberNotationError extends Error {}

const parseObject = (text: string, origin: string): ReadInputResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, (key, value: unknown, context?: { source?: string }) => {
      // The source text tells exponent notation apart, which the parsed value no longer shows.
      if (typeof value === "number" && !decimalNumberPattern.test(context?.source ?? "")) {
        throw new NumberNotationError(`${key}: ${decimalNumberMessage}`);
      }
      return value;
    });
  } catch (error) {
    if (error instanceof NumberNotationError) {
      return { message: `${origin}: ${error.message}`, ok: false };
    }
    const reason = error instanceof Error ? error.message : String(error);
    return { message: `${origin} is not valid JSON: ${reason}`, ok: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { message: `${origin} must be a JSON object`, ok: false };
  }
  return { ok: true, values: { ...parsed } };
};

/**
 * Reads the value of `--input`.
 *
 * A value that starts with `{` after leading white space is a JSON object. Any other value is
 * the path of a `.json` file, relative to the current directory.
 */
export const readWorkflowInput = async (value: string, cwd: string): Promise<ReadInputResult> => {
  if (value.trimStart().startsWith("{")) {
    return parseObject(value, "--input");
  }
  if (extname(value) !== ".json") {
    return {
      message: `--input must be a JSON object or the path of a .json file: ${value}`,
      ok: false,
    };
  }
  let text: string;
  try {
    text = await readFile(resolve(cwd, value), "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { message: `Failed to read ${value}: ${reason}`, ok: false };
  }
  return parseObject(text, value);
};
