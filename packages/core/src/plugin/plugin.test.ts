import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAiRunner,
  createPluginRegistry,
  defineAiProvider,
  definePlugin,
  defineWaitMethod,
  toJsonSchema,
  validatePluginConfig,
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
      builtins: [definePlugin({ name: "ugoke", waitMethods: [terminal] })],
      plugins: [definePlugin({ name: "acme", waitMethods: [slack, { ...terminal }] })],
    });

    expect(registry.waitMethodNames()).toEqual(["terminal", "acme/slack", "acme/terminal"]);
    expect(registry.waitMethod("terminal")).toBe(terminal);
    expect(registry.waitMethod("acme/slack")).toBe(slack);
    expect(registry.waitMethod("slack")).toBeUndefined();
  });

  it("is empty without plugins", () => {
    expect(createPluginRegistry().waitMethodNames()).toEqual([]);
    expect(createPluginRegistry().aiProviderNames()).toEqual([]);
  });

  it("registers AI providers like wait methods", () => {
    const claude = defineAiProvider({
      name: "claude-code",
      run: async () => ({ data: "" }),
      with: z.strictObject({}),
    });
    const registry = createPluginRegistry({
      builtins: [definePlugin({ aiProviders: [claude], name: "claude" })],
      plugins: [definePlugin({ aiProviders: [{ ...claude }], name: "acme" })],
    });

    expect(registry.aiProviderNames()).toEqual(["claude-code", "acme/claude-code"]);
    expect(registry.aiProvider("claude-code")).toBe(claude);
    expect(registry.aiProvider("codex")).toBeUndefined();
  });

  it("rejects duplicate and invalid AI provider names", () => {
    const claude = defineAiProvider({
      name: "claude-code",
      run: async () => ({ data: "" }),
      with: z.strictObject({}),
    });

    expect(() =>
      createPluginRegistry({
        builtins: [
          definePlugin({ aiProviders: [claude], name: "a" }),
          definePlugin({ aiProviders: [claude], name: "b" }),
        ],
      }),
    ).toThrow("Duplicate AI provider: claude-code");
    expect(() =>
      createPluginRegistry({
        builtins: [definePlugin({ aiProviders: [{ ...claude, name: "1bad" }], name: "a" })],
      }),
    ).toThrow("Invalid AI provider name: 1bad");
  });

  it("rejects duplicate wait method names", () => {
    expect(() =>
      createPluginRegistry({
        builtins: [
          definePlugin({ name: "ugoke", waitMethods: [terminal] }),
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

    expect(options.ok && terminal.answers?.(options.value, undefined)).toEqual({
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

describe("createAiRunner", () => {
  const requests: unknown[] = [];
  const plugins = createPluginRegistry({
    builtins: [
      definePlugin({
        aiProviders: [
          defineAiProvider({
            name: "claude-code",
            run: async (request) => {
              requests.push(request);
              return { data: "done", sessionId: "s1" };
            },
            with: z.strictObject({ limit: z.number().default(3) }),
          }),
        ],
        name: "claude",
      }),
    ],
  });
  const runner = createAiRunner({ cwd: "/project", plugins });
  const signal = new AbortController().signal;

  it("runs the provider that the step names, with its validated options", async () => {
    await expect(
      runner.run({ options: {}, prompt: "Hi", provider: "claude-code", timeoutMs: 1 }, { signal }),
    ).resolves.toEqual({ data: "done", sessionId: "s1" });
    expect(requests).toEqual([
      { cwd: "/project", options: { limit: 3 }, prompt: "Hi", timeoutMs: 1 },
    ]);
  });

  it("rejects an unknown provider and invalid options", async () => {
    await expect(
      runner.run({ options: {}, prompt: "Hi", provider: "codex", timeoutMs: 1 }, { signal }),
    ).rejects.toThrow("Unknown AI provider: codex");
    await expect(
      runner.run(
        { options: { limit: "x" }, prompt: "Hi", provider: "claude-code", timeoutMs: 1 },
        { signal },
      ),
    ).rejects.toThrow("Invalid options of AI provider claude-code: limit:");
  });
});

describe("plugin settings", () => {
  const notify = definePlugin({
    aiProviders: [
      defineAiProvider<unknown, { model: string }>({
        name: "echo",
        run: async ({ config }) => ({ data: config.model }),
        with: z.object({}),
      }),
    ],
    config: z.strictObject({ model: z.string().default("small") }),
    name: "notify",
  });

  it("validates the settings with the schema of the plugin, and applies its defaults", () => {
    expect(validatePluginConfig(notify, null)).toEqual({ ok: true, value: { model: "small" } });
    expect(validatePluginConfig(notify, { model: "large" })).toEqual({
      ok: true,
      value: { model: "large" },
    });
    expect(validatePluginConfig(notify, { size: 1 })).toMatchObject({ ok: false });
  });

  it("takes no settings for a plugin without a schema", () => {
    const plain = definePlugin({ name: "plain" });

    expect(validatePluginConfig(plain, null)).toEqual({ ok: true, value: undefined });
    expect(validatePluginConfig(plain, {})).toEqual({ ok: true, value: undefined });
    expect(validatePluginConfig(plain, { model: "large" })).toEqual({
      errors: [{ message: "The plugin takes no settings", path: [] }],
      ok: false,
    });
  });

  it("gives the settings of the plugin to the provider that runs a step", async () => {
    const plugins = createPluginRegistry({
      configs: new Map([["notify", { model: "large" }]]),
      plugins: [notify],
    });

    expect(plugins.aiProviderConfig("notify/echo")).toEqual({ model: "large" });
    await expect(
      createAiRunner({ cwd: "/", plugins }).run(
        { options: {}, prompt: "Hi", provider: "notify/echo", timeoutMs: 1000 },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ data: "large" });
  });

  it("takes the type of the settings only from the schema of the plugin", () => {
    const reader = defineWaitMethod<unknown, { channel: string }>({
      name: "ask",
      respond: async ({ config }) => ({ channel: config.channel }),
      with: z.object({}),
    });

    // The settings that the method reads match the schema.
    const declared = definePlugin({
      config: z.strictObject({ channel: z.string() }),
      name: "declared",
      waitMethods: [reader],
    });
    // A plugin without the schema takes no settings, so the method could not read them.
    // @ts-expect-error -- The method reads settings that the plugin does not declare.
    const undeclared = definePlugin({ name: "undeclared", waitMethods: [reader] });

    expect([declared.name, undeclared.name]).toEqual(["declared", "undeclared"]);
  });
});

describe("toJsonSchema", () => {
  it("converts a schema that implements Standard JSON Schema, without $schema", () => {
    expect(toJsonSchema(z.strictObject({ channel: z.string() }))).toEqual({
      additionalProperties: false,
      properties: { channel: { type: "string" } },
      required: ["channel"],
      type: "object",
    });
  });

  it("returns nothing for a schema that cannot be converted", () => {
    const plain: StandardSchemaV1 = {
      "~standard": { validate: (value) => ({ value }), vendor: "test", version: 1 },
    };
    const failing = {
      "~standard": {
        ...plain["~standard"],
        jsonSchema: {
          input: () => {
            throw new Error("Not supported");
          },
          output: () => ({}),
        },
      },
    };

    expect(toJsonSchema(plain)).toBeUndefined();
    expect(toJsonSchema(failing)).toBeUndefined();
  });
});
