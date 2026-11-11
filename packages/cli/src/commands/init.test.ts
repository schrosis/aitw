import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadProjectConfig } from "../config.ts";
import { createOutput } from "../testing.ts";
import { init } from "./init.ts";
import { validate } from "./validate.ts";

describe("init", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "aitw-init-")));
  });

  afterEach(() => {
    rmSync(cwd, { force: true, recursive: true });
  });

  it("creates a project with a sample workflow and its JSON Schemas", async () => {
    const output = createOutput();

    await expect(init({ cwd, ...output })).resolves.toBe(0);

    expect(output.written).toEqual({
      stderr: "",
      stdout: [
        "wrote .aitw/config.yaml",
        "wrote .aitw/workflows/hello.yaml",
        "wrote .aitw/schemas/workflow.schema.json",
        "wrote .aitw/schemas/config.schema.json",
        "",
        "Next:",
        "  aitw daemon start",
        "  aitw run hello",
        "",
      ].join("\n"),
    });
    // The files refer to the schemas that were generated next to them.
    expect(readFileSync(join(cwd, ".aitw", "config.yaml"), "utf8")).toMatch(
      /^\$schema: \.\/schemas\/config\.schema\.json\n/u,
    );
    expect(readFileSync(join(cwd, ".aitw", "workflows", "hello.yaml"), "utf8")).toMatch(
      /^\$schema: \.\.\/schemas\/workflow\.schema\.json\n/u,
    );
    await expect(loadProjectConfig(cwd, cwd)).resolves.toEqual({
      $schema: "./schemas/config.schema.json",
    });
    await expect(validate("hello", { cwd, ...createOutput() })).resolves.toBe(0);
  });

  it("leaves a directory that already has .aitw as it is", async () => {
    mkdirSync(join(cwd, ".aitw"));
    const output = createOutput();

    await expect(init({ cwd, ...output })).resolves.toBe(1);

    expect(output.written).toEqual({
      stderr: `.aitw already exists in ${cwd}\n`,
      stdout: "",
    });
    expect(existsSync(join(cwd, ".aitw", "config.yaml"))).toBe(false);
  });
});
