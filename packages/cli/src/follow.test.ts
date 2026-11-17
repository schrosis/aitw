import { PassThrough, Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { CommandContext } from "./commands/load.ts";
import { createTerminal, followRun, fromAiNeedsDurableServer } from "./follow.ts";
import type { OpenedServer } from "./server.ts";
import { fixtureProject } from "./testing.ts";

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

/** A server that the command connected to, which keeps its runs or not. */
const server = (durable: boolean): OpenedServer => ({
  address: "127.0.0.1:7233",
  durable,
  options: durable ? " --dev --dev-db state.db" : " --dev",
  stop: async () => {},
});

describe("followRun", () => {
  it("prepares the engine right before it follows the run", async () => {
    const calls: string[] = [];
    const exitCode = await followRun(
      {
        follow: async () => {
          calls.push("follow");
          return { executedSteps: ["check"], status: "completed", workflowId: "run-1" };
        },
        interrupt: new AbortController().signal,
        name: "run-success",
        prepareEngine: () => calls.push("prepareEngine"),
        root: fixtureProject,
        server: server(true),
      },
      createContext(Readable.from([])),
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual(["prepareEngine", "follow"]);
  });

  // An installed runtime would keep the process alive, because no Worker shuts it down.
  it("does not prepare the engine when --from-ai cannot follow on the server", async () => {
    const prepareEngine = vi.fn();
    const follow = vi.fn();
    const context = createContext(Readable.from([]));
    const exitCode = await followRun(
      {
        follow,
        fromAi: true,
        interrupt: new AbortController().signal,
        name: "run-success",
        prepareEngine,
        root: fixtureProject,
        server: server(false),
      },
      context,
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(context.written())).toEqual({
      message: fromAiNeedsDurableServer,
      type: "failed",
    });
    expect(prepareEngine).not.toHaveBeenCalled();
    expect(follow).not.toHaveBeenCalled();
  });
});
