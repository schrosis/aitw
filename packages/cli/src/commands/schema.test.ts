import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOutput } from "../testing.ts";
import { schema } from "./schema.ts";

/** A plugin whose settings and wait method have schemas that convert to JSON Schema. */
const pluginSource = `
const schema = (jsonSchema) => ({
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => ({ value }),
    jsonSchema: { input: () => jsonSchema, output: () => jsonSchema },
  },
});
export default {
  name: "notify",
  config: schema({ type: "object", properties: { channel: { type: "string" } } }),
  waitMethods: [{ name: "ask", with: schema({ type: "object", properties: { to: { type: "string" } } }) }],
};
`;

describe("schema", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ugoke-schema-")));
    mkdirSync(join(root, ".ugoke"));
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  const read = (name: string): unknown =>
    JSON.parse(readFileSync(join(root, ".ugoke", "schemas", name), "utf8"));

  it("writes the JSON Schemas with the extensions and settings of the plugins", async () => {
    const plugin = join(root, "node_modules", "ugoke-notify");
    mkdirSync(plugin, { recursive: true });
    writeFileSync(
      join(plugin, "package.json"),
      '{"name":"ugoke-notify","type":"module","main":"index.js"}',
    );
    writeFileSync(join(plugin, "index.js"), pluginSource);
    writeFileSync(
      join(root, ".ugoke", "config.yaml"),
      '$schema: ./schemas/config.schema.json\nplugins:\n  "ugoke-notify":\n    channel: deploy\n',
    );
    const output = createOutput();

    await expect(schema({ cwd: root, ...output })).resolves.toBe(0);

    expect(output.written).toEqual({
      stderr: "",
      stdout:
        "wrote .ugoke/schemas/workflow.schema.json\nwrote .ugoke/schemas/config.schema.json\n",
    });
    const steps = "properties.steps.additionalProperties.oneOf";
    expect(read("workflow.schema.json")).toHaveProperty(`${steps}.1.properties.method.enum`, [
      "terminal",
      "notify/ask",
    ]);
    expect(read("workflow.schema.json")).toHaveProperty(
      `${steps}.1.allOf.1.then.properties.with.properties.to.type`,
      "string",
    );
    expect(read("config.schema.json")).toHaveProperty(
      "anyOf.0.properties.plugins.properties.ugoke-notify.anyOf",
      [{ type: "null" }, { properties: { channel: { type: "string" } }, type: "object" }],
    );
  });

  it("allows no settings for a plugin without a schema of its settings", async () => {
    const output = createOutput();

    await expect(schema({ cwd: root, ...output })).resolves.toBe(0);
    expect(read("config.schema.json")).toHaveProperty("anyOf.0.properties.plugins.properties", {});
  });

  it("fails when a plugin of the project cannot be loaded", async () => {
    writeFileSync(join(root, ".ugoke", "config.yaml"), 'plugins:\n  "ugoke-missing":\n');
    const output = createOutput();

    await expect(schema({ cwd: root, ...output })).resolves.toBe(1);
    expect(output.written.stderr).toContain("Plugin ugoke-missing is not installed");
  });

  it("fails outside a project", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "ugoke-outside-")));
    try {
      const output = createOutput();

      await expect(schema({ cwd: outside, ...output })).resolves.toBe(1);
      expect(output.written.stderr).toContain("No .ugoke directory found");
    } finally {
      rmSync(outside, { force: true, recursive: true });
    }
  });
});
