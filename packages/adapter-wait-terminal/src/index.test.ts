import { validateWithSchema } from "@aitw/core";
import type { InputDeclaration } from "@aitw/core";
import { describe, expect, it } from "vitest";

import {
  createTerminalPlugin,
  formatPrompt,
  parseAnswer,
  terminalPlugin,
  terminalWaitMethod,
} from "./index.ts";

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
) => {
  let output = "";
  const method = createTerminalPlugin({
    readLine: async () => lines.shift() ?? null,
    write: (text) => {
      output += text;
    },
  }).waitMethods?.[0];
  const validated = validateWithSchema(terminalWaitMethod.with, options);
  if (method?.respond === undefined || !validated.ok) {
    throw new Error("The test setup is invalid");
  }
  const answers = method.answers?.(validated.value, undefined) ?? {};
  const values = await method.respond({
    answers,
    config: undefined,
    options: validated.value,
    signal,
    step: "ask",
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
