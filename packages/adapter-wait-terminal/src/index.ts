import {
  decimalNumberMessage,
  decimalNumberPattern,
  defineWaitMethod,
  definePlugin,
  inputDeclarationsSchema,
} from "@aitw/core";
import type { InputDeclaration, WaitMethod, WaitResponseContext } from "@aitw/core";
import { z } from "zod";

/** Options of the `terminal` wait method, as the `with` field of a step writes them. */
const optionsSchema = z.strictObject({
  message: z.string().min(1).describe("Message that the terminal shows before asking"),
  schema: inputDeclarationsSchema
    .default({})
    .describe("Values to ask for. Without it, the step waits until Enter is pressed"),
});

/** Options of the `terminal` wait method. */
export type TerminalOptions = z.infer<typeof optionsSchema>;

/** The terminal that the method asks in. */
export interface TerminalIO {
  /** Writes text without adding a newline. */
  write: (text: string) => void;
  /**
   * Reads the next line without its line ending.
   *
   * @returns The line, or `null` when the input ends.
   */
  readLine: (signal: AbortSignal) => Promise<string | null>;
}

/**
 * Result of {@link parseAnswer}. A missing value means that the answer is not given, and the
 * workflow uses `null` for it.
 */
type Parsed = { ok: true; value?: boolean | number | string } | { ok: false; message: string };

const trueWords = new Set(["y", "yes", "true"]);
const falseWords = new Set(["n", "no", "false"]);

/**
 * Parses a line that answers a declaration.
 *
 * An empty line uses the default. Without a default, it leaves an optional answer not given,
 * because the workflow accepts only values of the declared type.
 */
export const parseAnswer = (declaration: InputDeclaration, line: string): Parsed => {
  const text = declaration.type === "string" ? line : line.trim();
  if (text === "") {
    if (declaration.default !== undefined) {
      return { ok: true, value: declaration.default };
    }
    return declaration.required ? { message: "A value is required", ok: false } : { ok: true };
  }
  if (declaration.type === "string") {
    return { ok: true, value: text };
  }
  if (declaration.type === "number") {
    return decimalNumberPattern.test(text)
      ? { ok: true, value: Number(text) }
      : { message: decimalNumberMessage, ok: false };
  }
  if (declaration.type === "boolean") {
    const word = text.toLowerCase();
    if (trueWords.has(word)) {
      return { ok: true, value: true };
    }
    return falseWords.has(word)
      ? { ok: true, value: false }
      : { message: "Enter y or n", ok: false };
  }
  return declaration.options.includes(text)
    ? { ok: true, value: text }
    : { message: `Enter one of ${declaration.options.join(", ")}`, ok: false };
};

/** Formats the prompt of a declaration, such as `approve (y/n, required): `. */
export const formatPrompt = (name: string, declaration: InputDeclaration): string => {
  const kind =
    declaration.type === "boolean"
      ? "y/n"
      : declaration.type === "choice"
        ? declaration.options.join("/")
        : declaration.type;
  const details = [
    kind,
    ...(declaration.required ? ["required"] : []),
    ...(declaration.default === undefined ? [] : [`default: ${String(declaration.default)}`]),
  ];
  const description = declaration.description === undefined ? "" : ` ${declaration.description}`;
  return `${name}${description} (${details.join(", ")}): `;
};

const inputEnded = (): Error => new Error("The input ended before the answer was entered");

const respond =
  ({ readLine, write }: TerminalIO) =>
  async ({
    answers,
    options,
    signal,
  }: WaitResponseContext<TerminalOptions>): Promise<Record<string, unknown>> => {
    write(`${options.message}\n`);
    const entries = Object.entries(answers);
    if (entries.length === 0) {
      write("Press Enter to continue: ");
      if ((await readLine(signal)) === null) {
        throw inputEnded();
      }
      return {};
    }

    const values: Record<string, unknown> = {};
    for (const [name, declaration] of entries) {
      for (;;) {
        write(formatPrompt(name, declaration));
        const line = await readLine(signal);
        if (line === null) {
          throw inputEnded();
        }
        const parsed = parseAnswer(declaration, line);
        if (parsed.ok) {
          if (parsed.value !== undefined) {
            values[name] = parsed.value;
          }
          break;
        }
        write(`${parsed.message}\n`);
      }
    }
    return values;
  };

const createMethod = (io?: TerminalIO): WaitMethod<TerminalOptions> =>
  defineWaitMethod({
    answers: ({ schema }) => schema,
    name: "terminal",
    ...(io === undefined ? {} : { respond: respond(io) }),
    with: optionsSchema,
  });

/**
 * Waits for an answer that someone enters in the terminal of `aitw run`.
 *
 * The answers are the values that `schema` declares. This instance only validates definitions;
 * use {@link createTerminalPlugin} to answer.
 */
export const terminalWaitMethod = createMethod();

/** The built-in plugin that provides the `terminal` wait method, for validating definitions. */
export const terminalPlugin = definePlugin({
  name: "terminal",
  waitMethods: [terminalWaitMethod],
});

/** Creates the built-in plugin of the `terminal` wait method that asks in a terminal. */
export const createTerminalPlugin = (io: TerminalIO) =>
  definePlugin({ name: "terminal", waitMethods: [createMethod(io)] });
