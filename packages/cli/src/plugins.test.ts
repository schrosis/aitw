import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOutput } from "./testing.ts";

import { validate } from "./commands/validate.ts";
import { PluginLoadError } from "./plugin-loader.ts";
import { createRegistry, loadProjectPlugins } from "./plugins.ts";

/**
 * Source of a plugin module whose settings need a channel, and whose wait method answers with it.
 */
const configuredPluginSource = `
const schema = (validate) => ({ "~standard": { version: 1, vendor: "test", validate } });
export default {
  name: "notify",
  config: schema((value) =>
    typeof value.channel === "string"
      ? { value: { channel: value.channel } }
      : { issues: [{ message: "Must be a string", path: ["channel"] }] },
  ),
  waitMethods: [
    {
      name: "ask",
      with: schema((value) => ({ value })),
      respond: async ({ config }) => ({ channel: config.channel }),
    },
  ],
};
`;

/** Source of a plugin module that provides a wait method. */
const pluginSource = (name: string): string => `
const schema = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => ({ value }),
  },
};
export default { name: ${JSON.stringify(name)}, waitMethods: [{ name: "manual", with: schema }] };
`;

describe("loadProjectPlugins", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ugoke-plugins-")));
    mkdirSync(join(root, ".ugoke"));
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  /** Installs a package in the project. */
  const install = (
    packageName: string,
    manifest: Record<string, unknown>,
    files: Record<string, string>,
  ) => {
    const directory = join(root, "node_modules", packageName);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name: packageName, type: "module", ...manifest }),
    );
    for (const [file, source] of Object.entries(files)) {
      writeFileSync(join(directory, file), source);
    }
  };

  const configure = (packages: string[]): void => {
    writeFileSync(
      join(root, ".ugoke", "config.yaml"),
      `plugins:\n${packages.map((name) => `  "${name}":\n`).join("")}`,
    );
  };

  it("loads no plugins without the configuration file", async () => {
    await expect(loadProjectPlugins(root, root)).resolves.toEqual([]);
  });

  it("loads the default export of the packages that the project names, in order", async () => {
    install(
      "@acme/ugoke-review",
      { exports: { ".": { import: "./main.js", types: "./main.d.ts" } } },
      {
        "main.js": pluginSource("review"),
      },
    );
    install("ugoke-plain", { main: "lib.js" }, { "lib.js": pluginSource("plain") });
    configure(["@acme/ugoke-review", "ugoke-plain"]);

    const loaded = await loadProjectPlugins(root, root);

    expect(loaded.map(({ packageName, plugin }) => [packageName, plugin.name])).toEqual([
      ["@acme/ugoke-review", "review"],
      ["ugoke-plain", "plain"],
    ]);
  });

  it("takes the first condition of exports in the order of its keys, as Node does", async () => {
    install(
      "ugoke-conditions",
      { exports: { import: "./imported.js", node: "./node.js", require: "./required.cjs" } },
      { "imported.js": pluginSource("imported"), "node.js": pluginSource("node") },
    );
    configure(["ugoke-conditions"]);

    const [loaded] = await loadProjectPlugins(root, root);

    expect(loaded?.plugin.name).toBe("imported");
  });

  it("loads the official Claude Code plugin, whose provider keeps its short name", async () => {
    // The plugin is installed next to ugoke, as a development dependency here.
    configure(["@ugoke/adapter-ai-claude-code"]);

    const registry = createRegistry(undefined, await loadProjectPlugins(root, root));

    expect(registry.aiProviderNames()).toEqual(["claude-code"]);
  });

  it("tells how to install a plugin that is missing", async () => {
    configure(["@acme/ugoke-missing"]);

    await expect(loadProjectPlugins(root, root)).rejects.toThrow(
      new PluginLoadError(
        'Plugin @acme/ugoke-missing is not installed in the project or next to ugoke. Install it, such as with "npm install --save-dev @acme/ugoke-missing"',
      ),
    );
  });

  it("rejects a package whose default export is not a plugin", async () => {
    install("ugoke-broken", { main: "index.js" }, { "index.js": "export const plugin = {};\n" });
    configure(["ugoke-broken"]);

    await expect(loadProjectPlugins(root, root)).rejects.toThrow(
      "Plugin ugoke-broken does not export a plugin as its default export",
    );
  });

  it("reports a package that fails to load", async () => {
    install("ugoke-throws", { main: "index.js" }, { "index.js": 'throw new Error("boom");\n' });
    configure(["ugoke-throws"]);

    await expect(loadProjectPlugins(root, root)).rejects.toThrow(
      "Plugin ugoke-throws failed to load: boom",
    );
  });

  it("names the extensions of official plugins without the plugin name", async () => {
    install(
      "@ugoke/adapter-wait-manual",
      { main: "index.js" },
      { "index.js": pluginSource("manual") },
    );
    install("@acme/ugoke-wait", { main: "index.js" }, { "index.js": pluginSource("acme") });
    configure(["@ugoke/adapter-wait-manual", "@acme/ugoke-wait"]);

    const registry = createRegistry(undefined, await loadProjectPlugins(root, root));

    expect(registry.waitMethodNames()).toEqual(["terminal", "manual", "acme/manual"]);
  });

  it("validates a definition with the extensions of the plugins of the project", async () => {
    install("@acme/ugoke-wait", { main: "index.js" }, { "index.js": pluginSource("acme") });
    configure(["@acme/ugoke-wait"]);
    mkdirSync(join(root, ".ugoke", "workflows"));
    writeFileSync(
      join(root, ".ugoke", "workflows", "approve.yaml"),
      "version: v0.1\nstart: approve\nsteps:\n  approve:\n    type: wait\n    method: acme/manual\n    next: end\n",
    );
    const output = createOutput();

    await expect(validate("approve", { cwd: root, ...output })).resolves.toBe(0);
    expect(output.written).toEqual({ stderr: "", stdout: "approve: valid\n" });
  });

  it("reports a plugin that cannot be loaded when it validates", async () => {
    configure(["@acme/ugoke-missing"]);
    mkdirSync(join(root, ".ugoke", "workflows"));
    writeFileSync(
      join(root, ".ugoke", "workflows", "approve.yaml"),
      "version: v0.1\nstart: done\nsteps:\n  done:\n    type: script\n    run: true\n    next: end\n",
    );
    const output = createOutput();

    await expect(validate("approve", { cwd: root, ...output })).resolves.toBe(1);
    expect(output.written.stderr).toContain("Plugin @acme/ugoke-missing is not installed");
  });

  it("tells which package provides an official AI provider that is not loaded", async () => {
    mkdirSync(join(root, ".ugoke", "workflows"));
    writeFileSync(
      join(root, ".ugoke", "workflows", "review.yaml"),
      "version: v0.1\nstart: review\nsteps:\n  review:\n    type: ai\n    provider: claude-code\n    prompt: Review\n    next: end\n",
    );
    const output = createOutput();

    await expect(validate("review", { cwd: root, ...output })).resolves.toBe(1);
    expect(output.written.stderr).toBe(
      ".ugoke/workflows/review.yaml:6:15 steps.review.provider: Unknown AI provider: claude-code. Install @ugoke/adapter-ai-claude-code and add it to plugins in .ugoke/config.yaml\n",
    );
  });

  it("validates the settings of a plugin, and gives them to its extensions", async () => {
    install("ugoke-notify", { main: "index.js" }, { "index.js": configuredPluginSource });
    writeFileSync(
      join(root, ".ugoke", "config.yaml"),
      'plugins:\n  "ugoke-notify":\n    channel: deploy\n',
    );

    const registry = createRegistry(undefined, await loadProjectPlugins(root, root));
    const method = registry.waitMethod("notify/ask");

    expect(registry.waitMethodConfig("notify/ask")).toEqual({ channel: "deploy" });
    await expect(
      method?.respond?.({
        answers: {},
        config: registry.waitMethodConfig("notify/ask"),
        options: {},
        run: { inputs: {}, workflowId: "deploy-1" },
        signal: new AbortController().signal,
        startedAt: new Date("2026-01-02T03:04:05.000Z"),
        step: "ask",
        visit: 0,
      }),
    ).resolves.toEqual({ channel: "deploy" });
  });

  it("reports invalid settings of a plugin with their locations", async () => {
    install("ugoke-notify", { main: "index.js" }, { "index.js": configuredPluginSource });
    install("ugoke-plain", { main: "index.js" }, { "index.js": pluginSource("plain") });
    const config = join(root, ".ugoke", "config.yaml");

    writeFileSync(config, 'plugins:\n  "ugoke-notify":\n    channel: 3\n');
    await expect(loadProjectPlugins(root, root)).rejects.toThrow(
      ".ugoke/config.yaml:3:14 plugins.ugoke-notify.channel: Must be a string",
    );

    writeFileSync(config, 'plugins:\n  "ugoke-plain":\n    channel: deploy\n');
    await expect(loadProjectPlugins(root, root)).rejects.toThrow(
      ".ugoke/config.yaml:3:5 plugins.ugoke-plain: The plugin takes no settings",
    );

    // Every plugin is checked, and their problems are reported together.
    writeFileSync(
      config,
      'plugins:\n  "ugoke-notify":\n    channel: 3\n  "ugoke-plain":\n    channel: deploy\n',
    );
    await expect(loadProjectPlugins(root, root)).rejects.toThrow(
      [
        ".ugoke/config.yaml:3:14 plugins.ugoke-notify.channel: Must be a string",
        ".ugoke/config.yaml:5:5 plugins.ugoke-plain: The plugin takes no settings",
      ].join("\n"),
    );
  });
});
