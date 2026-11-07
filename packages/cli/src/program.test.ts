import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProgram } from "./program.ts";
import type { ProgramContext } from "./program.ts";
import { createTestProject } from "./testing.ts";
import type { TestProject } from "./testing.ts";

describe("createProgram", () => {
  let project: TestProject;
  let stdout: string;
  let exitCode: number | undefined;

  beforeEach(() => {
    project = createTestProject();
    stdout = "";
    exitCode = undefined;
  });

  afterEach(() => {
    project.remove();
  });

  const context = (): ProgramContext => ({
    cwd: project.root,
    setExitCode: (code) => {
      exitCode = code;
    },
    stderr: () => {},
    stdout: (text) => {
      stdout += text;
    },
  });

  it("prints the package version", async () => {
    let output = "";
    const program = createProgram(context())
      .exitOverride()
      .configureOutput({ writeOut: (text) => (output += text) });

    await expect(program.parseAsync(["--version"], { from: "user" })).rejects.toMatchObject({
      code: "commander.version",
    });
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(manifest).toMatchObject({ version: output.trimEnd() });
    expect(output.endsWith("\n")).toBe(true);
  });

  it("sets the exit code of validate", async () => {
    project.write(".aitw/workflows/broken.yaml", "version: v9\n");

    await createProgram(context()).parseAsync(["validate", "broken"], { from: "user" });

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
  });
});
