import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadProjectConfig, ProjectConfigError } from "./config.ts";

describe("loadProjectConfig", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aitw-config-"));
    mkdirSync(join(root, ".aitw"));
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  const write = (name: string, source: string): void => {
    writeFileSync(join(root, ".aitw", name), source);
  };

  it("has no settings without the file", async () => {
    await expect(loadProjectConfig(root, root)).resolves.toEqual({});
  });

  it("has no settings in an empty file", async () => {
    write("config.yaml", "# Nothing is set yet\n");

    await expect(loadProjectConfig(root, root)).resolves.toEqual({});
  });

  it.each(["config.yaml", "config.yml"])(
    "reads the address of the Temporal Server from %s",
    async (name) => {
      write(name, "temporal:\n  address: temporal.example.com:7233\n");

      await expect(loadProjectConfig(root, root)).resolves.toEqual({
        temporal: { address: "temporal.example.com:7233" },
      });
    },
  );

  it("reports unknown fields and invalid values with their locations", async () => {
    write("config.yaml", "temporal:\n  address: 7233\n  namespace: default\nworkers: 2\n");

    await expect(loadProjectConfig(root, root)).rejects.toThrow(
      new ProjectConfigError(
        [
          ".aitw/config.yaml:2:12 temporal.address: Invalid input: expected string, received number",
          ".aitw/config.yaml:3:3 temporal.namespace: Unknown field: namespace",
          ".aitw/config.yaml:4:1 workers: Unknown field: workers",
        ].join("\n"),
      ),
    );
  });

  it("does not choose between config.yaml and config.yml", async () => {
    write("config.yaml", "");
    write("config.yml", "");

    await expect(loadProjectConfig(root, root)).rejects.toThrow(
      ".aitw has both config.yaml and config.yml. Keep one of them",
    );
  });

  it("reports a YAML syntax error", async () => {
    write("config.yaml", "temporal: [\n");

    await expect(loadProjectConfig(root, root)).rejects.toBeInstanceOf(ProjectConfigError);
  });

  it("reads the plugins in order, keyed by package name", async () => {
    write(
      "config.yaml",
      'plugins:\n  "@aitw/adapter-ai-claude-code":\n  "@acme/aitw-slack": {}\n  aitw-plain:\n',
    );

    const { plugins = {} } = await loadProjectConfig(root, root);

    expect(Object.keys(plugins)).toEqual([
      "@aitw/adapter-ai-claude-code",
      "@acme/aitw-slack",
      "aitw-plain",
    ]);
  });

  it("keeps the settings of plugins, and rejects names that are not packages", async () => {
    write("config.yaml", 'plugins:\n  "@acme/aitw-slack":\n    channel: deploy\n');

    await expect(loadProjectConfig(root, root)).resolves.toEqual({
      plugins: { "@acme/aitw-slack": { channel: "deploy" } },
    });

    write("config.yaml", "plugins:\n  ./local:\n");

    await expect(loadProjectConfig(root, root)).rejects.toThrow(
      new ProjectConfigError(
        ".aitw/config.yaml:2:3 plugins../local: Must be the name of an npm package, such as @acme/aitw-slack",
      ),
    );
  });

  it("reads how the progress is shown", async () => {
    write("config.yaml", "output:\n  showCommands: false\n");

    await expect(loadProjectConfig(root, root)).resolves.toEqual({
      output: { showCommands: false },
    });
  });
});
