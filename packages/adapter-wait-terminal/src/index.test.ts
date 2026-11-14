import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { validateWithSchema } from "@ugoke/core";
import type { InputDeclaration } from "@ugoke/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTerminalPlugin,
  formatPrompt,
  parseAnswer,
  terminalPlugin,
  terminalWaitMethod,
} from "./index.ts";
import type { TerminalIO, TerminalPluginOptions } from "./index.ts";

describe("terminalWaitMethod", () => {
  it("is provided by the terminal plugin", () => {
    expect(terminalPlugin.waitMethods).toEqual([terminalWaitMethod]);
  });

  it("answers with the declared schema, defaulting required to false", () => {
    const options = validateWithSchema(terminalWaitMethod.with, {
      message: "Enter your name",
      schema: {
        approve: { required: true, type: "boolean" },
        name: { description: "Your name", type: "string" },
      },
    });

    expect(options.ok && terminalWaitMethod.answers?.(options.value, undefined)).toEqual({
      approve: { required: true, type: "boolean" },
      name: { description: "Your name", required: false, type: "string" },
    });
  });

  it("answers with nothing when no schema is declared", () => {
    const options = validateWithSchema(terminalWaitMethod.with, { message: "Press Enter" });

    expect(options.ok && terminalWaitMethod.answers?.(options.value, undefined)).toEqual({});
  });

  it.each([
    [{}, ["message"]],
    [{ message: "" }, ["message"]],
    [{ extra: 1, message: "Hi" }, []],
    [{ message: "Hi", schema: { "my-name": { type: "string" } } }, ["schema", "my-name"]],
    [{ message: "Hi", schema: { name: { type: "integer" } } }, ["schema", "name", "type"]],
    [
      { message: "Hi", schema: { count: { multiline: true, type: "number" } } },
      ["schema", "count"],
    ],
    [
      { message: "Hi", schema: { level: { options: ["a", "a"], type: "choice" } } },
      ["schema", "level", "options"],
    ],
    [
      { message: "Hi", schema: { name: { default: "x", required: true, type: "string" } } },
      ["schema", "name", "default"],
    ],
  ])("rejects the options %j", (options, path) => {
    expect(validateWithSchema(terminalWaitMethod.with, options)).toMatchObject({
      errors: [{ path }],
      ok: false,
    });
  });
});

describe("parseAnswer", () => {
  it.each<[InputDeclaration, string, unknown]>([
    [{ required: false, type: "string" }, "  hello ", "  hello "],
    [{ default: false, required: false, type: "boolean" }, "", false],
    [{ default: "x", required: false, type: "string" }, "", "x"],
    [{ required: true, type: "number" }, " -1.5 ", -1.5],
    [{ required: true, type: "boolean" }, "Yes", true],
    [{ required: true, type: "boolean" }, "n", false],
    [{ options: ["low", "high"], required: true, type: "choice" }, "high", "high"],
  ])("parses %j from %j", (declaration, line, value) => {
    expect(parseAnswer(declaration, line)).toEqual({ ok: true, value });
  });

  it("leaves an empty optional answer without a default not given", () => {
    expect(parseAnswer({ required: false, type: "boolean" }, " ")).toEqual({ ok: true });
  });

  it.each<[InputDeclaration, string, string]>([
    [{ required: true, type: "string" }, "", "A value is required"],
    [{ required: true, type: "number" }, "1e3", "without exponent notation"],
    [{ required: true, type: "boolean" }, "maybe", "Enter y or n"],
    [{ options: ["low", "high"], required: true, type: "choice" }, "mid", "Enter one of low, high"],
  ])("rejects %j from %j", (declaration, line, message) => {
    expect(parseAnswer(declaration, line)).toEqual({
      message: expect.stringContaining(message) as unknown,
      ok: false,
    });
  });
});

describe("formatPrompt", () => {
  it("shows the type, whether it is required, and the default", () => {
    expect(formatPrompt("approve", { required: true, type: "boolean" })).toBe(
      "approve (y/n, required): ",
    );
    expect(
      formatPrompt("level", {
        default: "low",
        description: "Log level",
        options: ["low", "high"],
        required: false,
        type: "choice",
      }),
    ).toBe("level Log level (low/high, default: low): ");
  });
});

const respondWith = async (
  lines: string[],
  options: unknown,
  signal = new AbortController().signal,
  pluginOptions: TerminalPluginOptions = {},
) => {
  let output = "";
  const method = createTerminalPlugin(
    {
      readLine: async () => lines.shift() ?? null,
      write: (text) => {
        output += text;
      },
    },
    pluginOptions,
  ).waitMethods?.[0];
  const validated = validateWithSchema(terminalWaitMethod.with, options);
  if (method?.respond === undefined || !validated.ok) {
    throw new Error("The test setup is invalid");
  }
  const answers = method.answers?.(validated.value, undefined) ?? {};
  const values = await method.respond({
    answers,
    config: undefined,
    log: () => {},
    options: validated.value,
    run: { inputs: {}, workflowId: "ask-1" },
    signal,
    startedAt: new Date("2026-01-02T03:04:05.000Z"),
    step: "ask",
    visit: 0,
  });
  return { output, values };
};

describe("createTerminalPlugin", () => {
  it("asks for every answer and asks again after an invalid value", async () => {
    await expect(
      respondWith(["", "schrosis", "maybe", "y"], {
        message: "Enter your name",
        schema: {
          name: { required: true, type: "string" },
          approve: { type: "boolean" },
        },
      }),
    ).resolves.toEqual({
      output:
        "Enter your name\nname (string, required): A value is required\nname (string, required): approve (y/n): Enter y or n\napprove (y/n): ",
      values: { approve: true, name: "schrosis" },
    });
  });

  it("leaves the message to the progress of the run, when asked", async () => {
    await expect(
      respondWith(
        ["schrosis"],
        { message: "Enter your name", schema: { name: { type: "string" } } },
        undefined,
        { showMessage: false },
      ),
    ).resolves.toMatchObject({ output: "name (string): " });
  });

  it("does not send an empty optional answer", async () => {
    await expect(
      respondWith(["schrosis", ""], {
        message: "Enter your name",
        schema: { name: { type: "string" }, approve: { type: "boolean" } },
      }),
    ).resolves.toMatchObject({ values: { name: "schrosis" } });
  });

  it("waits for Enter when no answers are declared", async () => {
    await expect(respondWith([""], { message: "Continue?" })).resolves.toEqual({
      output: "Continue?\nPress Enter to continue: ",
      values: {},
    });
  });

  it("fails when the input ends", async () => {
    await expect(
      respondWith([], { message: "Name?", schema: { name: { type: "string" } } }),
    ).rejects.toThrow("The input ended before the answer was entered");
  });

  it("does not answer without a terminal", () => {
    expect("respond" in terminalWaitMethod).toBe(false);
  });
});

describe("createTerminalPlugin with line input", () => {
  const multiline = {
    message: "Describe the change",
    schema: { prompt: { multiline: true, required: true, type: "string" } },
  };

  it("reads a multiline answer until a line of a dot", async () => {
    await expect(
      respondWith(["Fix the login.", "", "Add tests.", "."], multiline),
    ).resolves.toEqual({
      output:
        'Describe the change\nprompt (string, multiline, required). End with a line of ".":\n',
      values: { prompt: "Fix the login.\n\nAdd tests." },
    });
  });

  it("asks again for an empty required multiline answer", async () => {
    await expect(respondWith([".", "Fix it.", "."], multiline)).resolves.toMatchObject({
      output: expect.stringContaining("A value is required\n") as unknown,
      values: { prompt: "Fix it." },
    });
  });

  it("fails when the input ends before the line of a dot", async () => {
    await expect(respondWith(["Fix the login."], multiline)).rejects.toThrow(
      "The input ended before the answer was entered",
    );
  });
});

/** Keys that the interactive tests press. */
const keys = { ctrlC: "\u0003", down: "\u001B[B", enter: "\r" };

/** A terminal for the interactive prompts, which a test types in. */
const createInteractiveTerminal = () => {
  const input = new PassThrough();
  // The output of a terminal is never ended, which the test checks after every prompt.
  const output = new PassThrough();
  output.on("finish", () => {
    throw new Error("The prompt ended the output of the terminal");
  });
  let screen = "";
  output.on("data", (chunk: Buffer) => {
    screen += chunk.toString();
  });
  const interrupted = new AbortController();
  const io: TerminalIO = {
    interactive: () => ({ input, interrupt: () => interrupted.abort(), output }),
    readLine: () => Promise.reject(new Error("The test reads only keys")),
    write: () => {},
  };
  /** Waits until the screen shows the text, and then types the keys. */
  const press = async (text: string, ...typed: string[]) => {
    await vi.waitFor(() => {
      expect(screen).toContain(text);
    });
    screen = "";
    for (const key of typed) {
      input.write(key);
    }
  };
  return { interrupted: interrupted.signal, io, press, screen: () => screen };
};

const respondInteractively = async (
  io: TerminalIO,
  options: unknown,
  signal = new AbortController().signal,
) => {
  const method = createTerminalPlugin(io, { showMessage: false }).waitMethods?.[0];
  const validated = validateWithSchema(terminalWaitMethod.with, options);
  if (method?.respond === undefined || !validated.ok) {
    throw new Error("The test setup is invalid");
  }
  return method.respond({
    answers: method.answers?.(validated.value, undefined) ?? {},
    config: undefined,
    log: () => {},
    options: validated.value,
    run: { inputs: {}, workflowId: "ask-1" },
    signal,
    startedAt: new Date("2026-01-02T03:04:05.000Z"),
    step: "ask",
    visit: 0,
  });
};

describe("createTerminalPlugin with interactive prompts", () => {
  it("asks for every answer in turn", async () => {
    const { io, press } = createInteractiveTerminal();
    const answered = respondInteractively(io, {
      message: "Deploy",
      schema: {
        env: { options: ["staging", "production"], required: true, type: "choice" },
        reason: { required: true, type: "string" },
      },
    });

    await press("production", keys.down, keys.enter);
    await press("reason (string)", "hotfix", keys.enter);

    await expect(answered).resolves.toEqual({ env: "production", reason: "hotfix" });
  });

  it("leaves an optional choice not given when (skip) is chosen", async () => {
    const { io, press } = createInteractiveTerminal();
    const answered = respondInteractively(io, {
      message: "Deploy",
      schema: {
        env: { description: "Target", options: ["staging", "production"], type: "choice" },
      },
    });

    await press("(skip)", keys.down, keys.down, keys.enter);

    await expect(answered).resolves.toEqual({});
  });

  it("chooses an option that is not the first", async () => {
    const { io, press } = createInteractiveTerminal();
    const answered = respondInteractively(io, {
      message: "Deploy",
      schema: {
        env: { options: ["staging", "production"], required: true, type: "choice" },
      },
    });

    await press("production", keys.down, keys.enter);

    await expect(answered).resolves.toEqual({ env: "production" });
  });

  it("confirms a boolean that has a default with Enter", async () => {
    const { io, press } = createInteractiveTerminal();
    const answered = respondInteractively(io, {
      message: "Deploy",
      schema: { approve: { default: false, type: "boolean" } },
    });

    await press("approve", keys.enter);

    await expect(answered).resolves.toEqual({ approve: false });
  });

  it("asks to type a boolean without a default, so that Enter alone does not answer it", async () => {
    const { io, press } = createInteractiveTerminal();
    const answered = respondInteractively(io, {
      message: "Deploy",
      schema: { approve: { required: true, type: "boolean" } },
    });

    await press("approve (y/n)", keys.enter);
    await press("A value is required", "y", keys.enter);

    await expect(answered).resolves.toEqual({ approve: true });
  });

  it("asks again for a value that does not match the type", async () => {
    const { io, press } = createInteractiveTerminal();
    const answered = respondInteractively(io, {
      message: "Scale",
      schema: { replicas: { required: true, type: "number" } },
    });

    await press("replicas (number)", "x", keys.enter);
    await press("without exponent notation", "\u007F", "3", keys.enter);

    await expect(answered).resolves.toEqual({ replicas: 3 });
  });

  it("uses the default of a string for an empty answer", async () => {
    const { io, press } = createInteractiveTerminal();
    const answered = respondInteractively(io, {
      message: "Greet",
      schema: { name: { default: "you", type: "string" } },
    });

    await press("name", keys.enter);

    await expect(answered).resolves.toEqual({ name: "you" });
  });

  it("waits for Enter when no answers are declared", async () => {
    const { io, press } = createInteractiveTerminal();
    const answered = respondInteractively(io, { message: "Continue?" });

    await press("Press Enter to continue", keys.enter);

    await expect(answered).resolves.toEqual({});
  });

  it("interrupts the command on Ctrl+C and waits for the signal", async () => {
    const { interrupted, io, press } = createInteractiveTerminal();
    const controller = new AbortController();
    interrupted.addEventListener("abort", () => controller.abort(new Error("Detached")));
    const answered = respondInteractively(
      io,
      { message: "Greet", schema: { name: { type: "string" } } },
      controller.signal,
    );

    await press("name", keys.ctrlC);

    await expect(answered).rejects.toThrow("Detached");
    expect(interrupted.aborted).toBe(true);
  });

  describe("with an editor", () => {
    let directory: string;

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), "ugoke-editor-"));
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      await rm(directory, { force: true, recursive: true });
    });

    /** Uses an editor that replaces the file with the text and records what the file had. */
    const stubEditor = async (text: string) => {
      const script = join(directory, "editor.sh");
      await writeFile(
        script,
        `#!/bin/sh\ncat "$1" > "${join(directory, "before.txt")}"\nprintf '%s' '${text}' > "$1"\n`,
      );
      await chmod(script, 0o755);
      vi.stubEnv("VISUAL", script);
    };

    it("asks for a multiline answer in the editor, filled with the default", async () => {
      await stubEditor("Fix the login.\n\nAdd tests.\n\n");
      const { io, press } = createInteractiveTerminal();
      const answered = respondInteractively(io, {
        message: "Describe the change",
        schema: { prompt: { default: "Fix", multiline: true, type: "string" } },
      });

      await press("prompt", keys.enter);

      await expect(answered).resolves.toEqual({ prompt: "Fix the login.\n\nAdd tests." });
      await expect(readFile(join(directory, "before.txt"), "utf8")).resolves.toBe("Fix");
    });
  });
});
