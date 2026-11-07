import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createProgram } from "./program.ts";

describe("createProgram", () => {
  it("prints the package version", async () => {
    let output = "";
    const program = createProgram()
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
});
