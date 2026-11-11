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
    write("config.yaml", "temporal:\n  address: 7233\n  namespace: default\nplugins: []\n");

    await expect(loadProjectConfig(root, root)).rejects.toThrow(
      new ProjectConfigError(
        [
          ".aitw/config.yaml:2:12 temporal.address: Invalid input: expected string, received number",
          ".aitw/config.yaml:3:3 temporal.namespace: Unknown field: namespace",
          ".aitw/config.yaml:4:1 plugins: Unknown field: plugins",
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
});
