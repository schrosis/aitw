import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadProjectConfig } from "../config.ts";
import { createOutput } from "../testing.ts";
import { init } from "./init.ts";
import { validate } from "./validate.ts";

/** Whether writing the JSON Schemas fails, such as on a full disk. */
const schemas = vi.hoisted(() => ({ fail: false }));

vi.mock("./schema.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./schema.ts")>();
  return {
    ...actual,
    writeSchemas: async (...args: Parameters<typeof actual.writeSchemas>) =>
      schemas.fail ? Promise.reject(new Error("The disk is full")) : actual.writeSchemas(...args),
  };
});

describe("init", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "ugoke-init-")));
  });

  afterEach(() => {
    schemas.fail = false;
    rmSync(cwd, { force: true, recursive: true });
  });

  it("creates a project with a sample workflow and its JSON Schemas", async () => {
    const output = createOutput();

    await expect(init({ cwd, ...output })).resolves.toBe(0);

    expect(output.written).toEqual({
      stderr: "",
      stdout: [
        "wrote .ugoke/config.yaml",
        "wrote .ugoke/workflows/hello.yaml",
        "wrote .ugoke/schemas/workflow.schema.json",
        "wrote .ugoke/schemas/config.schema.json",
        "",
        "Next:",
        "  ugoke daemon start",
        "  ugoke run hello",
        "",
      ].join("\n"),
    });
    // The files refer to the schemas that were generated next to them.
    expect(readFileSync(join(cwd, ".ugoke", "config.yaml"), "utf8")).toMatch(
      /^\$schema: \.\/schemas\/config\.schema\.json\n/u,
    );
    expect(readFileSync(join(cwd, ".ugoke", "workflows", "hello.yaml"), "utf8")).toMatch(
      /^\$schema: \.\.\/schemas\/workflow\.schema\.json\n/u,
    );
    await expect(loadProjectConfig(cwd, cwd)).resolves.toEqual({
      $schema: "./schemas/config.schema.json",
    });
    await expect(validate("hello", { cwd, ...createOutput() })).resolves.toBe(0);
  });

  it("leaves a directory that already has .ugoke as it is", async () => {
    mkdirSync(join(cwd, ".ugoke"));
    const output = createOutput();

    await expect(init({ cwd, ...output })).resolves.toBe(1);

    expect(output.written).toEqual({
      stderr: `.ugoke already exists in ${cwd}\n`,
      stdout: "",
    });
    expect(existsSync(join(cwd, ".ugoke", "config.yaml"))).toBe(false);
  });

  it("removes what it created when it fails, so that it can run again", async () => {
    schemas.fail = true;
    const output = createOutput();

    await expect(init({ cwd, ...output })).resolves.toBe(1);

    expect(output.written).toEqual({ stderr: "The disk is full\n", stdout: "" });
    expect(existsSync(join(cwd, ".ugoke"))).toBe(false);
    schemas.fail = false;
    await expect(init({ cwd, ...createOutput() })).resolves.toBe(0);
  });
});
