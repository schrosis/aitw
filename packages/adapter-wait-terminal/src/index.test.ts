import { validateWithSchema } from "@aitw/core";
import { describe, expect, it } from "vitest";

import { terminalPlugin, terminalWaitMethod } from "./index.ts";

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

    expect(options.ok && terminalWaitMethod.answers?.(options.value)).toEqual({
      approve: { required: true, type: "boolean" },
      name: { description: "Your name", required: false, type: "string" },
    });
  });

  it("answers with nothing when no schema is declared", () => {
    const options = validateWithSchema(terminalWaitMethod.with, { message: "Press Enter" });

    expect(options.ok && terminalWaitMethod.answers?.(options.value)).toEqual({});
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
