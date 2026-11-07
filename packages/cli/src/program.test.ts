import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createProgram } from "./program.ts";
import { createOutput, fixtureProject } from "./testing.ts";

const execute = async (args: string[]) => {
  const output = createOutput();
  let exitCode: number | undefined;
  await createProgram({
    cwd: fixtureProject,
    interruptSignal: () => new AbortController().signal,
    prepareEngine: () => {},
    setExitCode: (code) => {
      exitCode = code;
    },
    ...output,
  }).parseAsync(args, { from: "user" });
  return { exitCode, ...output.written };
};

describe("createProgram", () => {
  it("prints the package version", async () => {
    let output = "";
    const program = createProgram({
      cwd: fixtureProject,
      setExitCode: () => {},
      interruptSignal: () => new AbortController().signal,
      prepareEngine: () => {},
      ...createOutput(),
    })
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

  it("exits with zero when validate succeeds", async () => {
    await expect(execute(["validate", "valid"])).resolves.toMatchObject({
      exitCode: 0,
      stdout: "valid: valid\n",
    });
  });

  it("exits with one when validate fails", async () => {
    await expect(execute(["validate", "transition-error"])).resolves.toMatchObject({
      exitCode: 1,
      stdout: "",
    });
  });
});
