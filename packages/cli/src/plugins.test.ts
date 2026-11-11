import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOutput } from "./testing.ts";

import { validate } from "./commands/validate.ts";
import { PluginLoadError } from "./plugin-loader.ts";
import { createRegistry, loadProjectPlugins } from "./plugins.ts";

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
    root = realpathSync(mkdtempSync(join(tmpdir(), "aitw-plugins-")));
    mkdirSync(join(root, ".aitw"));
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
      join(root, ".aitw", "config.yaml"),
      `plugins:\n${packages.map((name) => `  "${name}":\n`).join("")}`,
    );
  };

  it("loads no plugins without the configuration file", async () => {
    await expect(loadProjectPlugins(root, root)).resolves.toEqual([]);
  });

  it("loads the default export of the packages that the project names, in order", async () => {
    install(
      "@acme/aitw-review",
      { exports: { ".": { import: "./main.js", types: "./main.d.ts" } } },
      {
        "main.js": pluginSource("review"),
      },
    );
    install("aitw-plain", { main: "lib.js" }, { "lib.js": pluginSource("plain") });
    configure(["@acme/aitw-review", "aitw-plain"]);

    const loaded = await loadProjectPlugins(root, root);

    expect(loaded.map(({ packageName, plugin }) => [packageName, plugin.name])).toEqual([
      ["@acme/aitw-review", "review"],
      ["aitw-plain", "plain"],
    ]);
  });

  it("takes the first condition of exports in the order of its keys, as Node does", async () => {
    install(
      "aitw-conditions",
      { exports: { import: "./imported.js", node: "./node.js", require: "./required.cjs" } },
      { "imported.js": pluginSource("imported"), "node.js": pluginSource("node") },
    );
    configure(["aitw-conditions"]);

    const [loaded] = await loadProjectPlugins(root, root);

    expect(loaded?.plugin.name).toBe("imported");
  });

  it("does not load a plugin that aitw has built in again", async () => {
    configure(["@aitw/adapter-ai-claude-code"]);

    await expect(loadProjectPlugins(root, root)).resolves.toEqual([]);
  });

  it("tells how to install a plugin that is missing", async () => {
    configure(["@acme/aitw-missing"]);

    await expect(loadProjectPlugins(root, root)).rejects.toThrow(
      new PluginLoadError(
        'Plugin @acme/aitw-missing is not installed in the project or next to aitw. Install it, such as with "npm install --save-dev @acme/aitw-missing"',
      ),
    );
  });

  it("rejects a package whose default export is not a plugin", async () => {
    install("aitw-broken", { main: "index.js" }, { "index.js": "export const plugin = {};\n" });
    configure(["aitw-broken"]);

    await expect(loadProjectPlugins(root, root)).rejects.toThrow(
      "Plugin aitw-broken does not export a plugin as its default export",
    );
  });

  it("reports a package that fails to load", async () => {
    install("aitw-throws", { main: "index.js" }, { "index.js": 'throw new Error("boom");\n' });
    configure(["aitw-throws"]);

    await expect(loadProjectPlugins(root, root)).rejects.toThrow(
      "Plugin aitw-throws failed to load: boom",
    );
  });

  it("names the extensions of official plugins without the plugin name", async () => {
    install(
      "@aitw/adapter-wait-manual",
      { main: "index.js" },
      { "index.js": pluginSource("manual") },
    );
    install("@acme/aitw-wait", { main: "index.js" }, { "index.js": pluginSource("acme") });
    configure(["@aitw/adapter-wait-manual", "@acme/aitw-wait"]);

    const registry = createRegistry(undefined, await loadProjectPlugins(root, root));

    expect(registry.waitMethodNames()).toEqual(["terminal", "manual", "acme/manual"]);
  });

  it("validates a definition with the extensions of the plugins of the project", async () => {
    install("@acme/aitw-wait", { main: "index.js" }, { "index.js": pluginSource("acme") });
    configure(["@acme/aitw-wait"]);
    mkdirSync(join(root, ".aitw", "workflows"));
    writeFileSync(
      join(root, ".aitw", "workflows", "approve.yaml"),
      "version: v0.1\nstart: approve\nsteps:\n  approve:\n    type: wait\n    method: acme/manual\n    next: end\n",
    );
    const output = createOutput();

    await expect(validate("approve", { cwd: root, ...output })).resolves.toBe(0);
    expect(output.written).toEqual({ stderr: "", stdout: "approve: valid\n" });
  });

  it("reports a plugin that cannot be loaded when it validates", async () => {
    configure(["@acme/aitw-missing"]);
    mkdirSync(join(root, ".aitw", "workflows"));
    writeFileSync(
      join(root, ".aitw", "workflows", "approve.yaml"),
      "version: v0.1\nstart: done\nsteps:\n  done:\n    type: script\n    run: true\n    next: end\n",
    );
    const output = createOutput();

    await expect(validate("approve", { cwd: root, ...output })).resolves.toBe(1);
    expect(output.written.stderr).toContain("Plugin @acme/aitw-missing is not installed");
  });
});
