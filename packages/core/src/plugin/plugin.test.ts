import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createPluginRegistry,
  definePlugin,
  defineWaitMethod,
  validateWithSchema,
} from "./index.ts";

const terminal = defineWaitMethod({
  answers: ({ schema }) => schema,
  name: "terminal",
  with: z.strictObject({
    message: z.string(),
    schema: z.record(
      z.string(),
      z.strictObject({ required: z.boolean(), type: z.literal("string") }),
    ),
  }),
});

const slack = defineWaitMethod({ name: "slack", with: z.strictObject({ channel: z.string() }) });

describe("createPluginRegistry", () => {
  it("uses short names for built-in plugins and prefixed names for others", () => {
    const registry = createPluginRegistry({
      builtins: [definePlugin({ name: "aitw", waitMethods: [terminal] })],
      plugins: [definePlugin({ name: "acme", waitMethods: [slack, { ...terminal }] })],
    });

    expect(registry.waitMethodNames()).toEqual(["terminal", "acme/slack", "acme/terminal"]);
    expect(registry.waitMethod("terminal")).toBe(terminal);
    expect(registry.waitMethod("acme/slack")).toBe(slack);
    expect(registry.waitMethod("slack")).toBeUndefined();
  });

  it("is empty without plugins", () => {
    expect(createPluginRegistry().waitMethodNames()).toEqual([]);
  });

  it("rejects duplicate wait method names", () => {
    expect(() =>
      createPluginRegistry({
        builtins: [
          definePlugin({ name: "aitw", waitMethods: [terminal] }),
          definePlugin({ name: "extra", waitMethods: [terminal] }),
        ],
      }),
    ).toThrow("Duplicate wait method: terminal");
  });

  it("rejects duplicate plugin names", () => {
    expect(() =>
      createPluginRegistry({
        builtins: [definePlugin({ name: "acme", waitMethods: [terminal] })],
        plugins: [definePlugin({ name: "acme", waitMethods: [slack] })],
      }),
    ).toThrow("Duplicate plugin: acme");
    expect(() =>
      createPluginRegistry({
        plugins: [
          definePlugin({ name: "acme", waitMethods: [slack] }),
          definePlugin({ name: "acme", waitMethods: [terminal] }),
        ],
      }),
    ).toThrow("Duplicate plugin: acme");
  });

  it.each([
    [{ name: "my-plugin" }, "Invalid plugin name: my-plugin"],
    [{ name: "acme", waitMethods: [{ ...slack, name: "a/b" }] }, "Invalid wait method name: a/b"],
  ])("rejects an invalid name", (plugin, message) => {
    expect(() => createPluginRegistry({ plugins: [plugin] })).toThrow(message);
  });
});

describe("defineWaitMethod", () => {
  it("passes the validated options to answers", () => {
    const options = validateWithSchema(terminal.with, {
      message: "Name?",
      schema: { name: { required: true, type: "string" } },
    });

    expect(options.ok && terminal.answers?.(options.value)).toEqual({
      name: { required: true, type: "string" },
    });
  });
});

describe("validateWithSchema", () => {
  it("returns the output of the schema", () => {
    expect(validateWithSchema(z.object({ count: z.number().default(1) }), {})).toEqual({
      ok: true,
      value: { count: 1 },
    });
  });

  it("converts issues to validation errors with their paths", () => {
    expect(validateWithSchema(slack.with, { channel: 1, extra: true })).toEqual({
      errors: [
        { message: expect.any(String) as unknown, path: ["channel"] },
        { message: expect.any(String) as unknown, path: [] },
      ],
      ok: false,
    });
  });

  it("accepts path segments as objects and drops symbol keys", () => {
    const schema: StandardSchemaV1<unknown, unknown> = {
      "~standard": {
        validate: () => ({
          issues: [{ message: "Invalid", path: [{ key: "a" }, 0, Symbol("hidden"), "b"] }],
        }),
        vendor: "test",
        version: 1,
      },
    };

    expect(validateWithSchema(schema, {})).toEqual({
      errors: [{ message: "Invalid", path: ["a", 0, "b"] }],
      ok: false,
    });
  });

  it("reports a schema that throws", () => {
    const schema: StandardSchemaV1<unknown, unknown> = {
      "~standard": {
        validate: () => {
          throw new Error("broken refinement");
        },
        vendor: "test",
        version: 1,
      },
    };

    expect(validateWithSchema(schema, {})).toEqual({
      errors: [{ message: "The schema failed: broken refinement", path: [] }],
      ok: false,
    });
  });

  it("rejects a schema that validates asynchronously", () => {
    const schema: StandardSchemaV1<unknown, unknown> = {
      "~standard": {
        validate: async () => Promise.reject(new Error("never awaited")),
        vendor: "test",
        version: 1,
      },
    };

    expect(validateWithSchema(schema, {})).toEqual({
      errors: [{ message: expect.stringContaining("asynchronously") as unknown, path: [] }],
      ok: false,
    });
  });
});
