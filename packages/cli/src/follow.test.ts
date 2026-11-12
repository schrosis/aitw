import { PassThrough, Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import type { CommandContext } from "./commands/load.ts";
import { createTerminal } from "./follow.ts";

const createContext = (
  stdin: NodeJS.ReadableStream,
  overrides: Partial<CommandContext> = {},
): CommandContext & { written: () => string } => {
  let written = "";
  return {
    columns: () => 100,
    cwd: "/",
    interrupt: () => {},
    stderr: () => {},
    stdin: () => stdin,
    stdout: (text) => {
      written += text;
    },
    written: () => written,
    ...overrides,
  };
};

const terminalInput = (): PassThrough => Object.assign(new PassThrough(), { isTTY: true });

describe("createTerminal", () => {
  it("asks with prompts when standard input and output are terminals", () => {
    const context = createContext(terminalInput());
    const streams = createTerminal(context).interactive?.();

    expect(streams).toBeDefined();
    expect(streams?.output).toHaveProperty("columns", 100);
    streams?.output.write("? name");
    expect(context.written()).toBe("? name");
  });

  it.each<[string, Partial<CommandContext>, NodeJS.ReadableStream]>([
    ["standard input is a pipe", {}, Readable.from(["y\n"])],
    ["standard output is not a terminal", { columns: undefined }, terminalInput()],
    ["the command cannot be interrupted", { interrupt: undefined }, terminalInput()],
  ])("reads lines when %s", (_name, overrides, stdin) => {
    expect(createTerminal(createContext(stdin, overrides)).interactive?.()).toBeUndefined();
  });

  it("reads lines again after a prompt", async () => {
    const input = terminalInput();
    const terminal = createTerminal(createContext(input));
    const signal = new AbortController().signal;

    const first = terminal.readLine(signal);
    input.write("1\n");
    await expect(first).resolves.toBe("1");
    terminal.interactive?.();
    const second = terminal.readLine(signal);
    input.write("2\n");

    await expect(second).resolves.toBe("2");
    terminal.close();
  });
});
