import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { documentMarker } from "@aitw/definition";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOutput } from "../testing.ts";
import { docs } from "./docs.ts";

const valid = `version: v0.1
start: a
steps:
  a:
    type: script
    run: ./a.sh
    next: end
`;

describe("docs", () => {
  let cwd: string;
  let workflows: string;

  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "aitw-docs-")));
    workflows = join(cwd, ".aitw", "workflows");
    mkdirSync(join(workflows, "release"), { recursive: true });
  });

  afterEach(() => {
    rmSync(cwd, { force: true, recursive: true });
  });

  const run = async (name?: string) => {
    const output = createOutput();
    const exitCode = await docs(name, { cwd, ...output });
    return { exitCode, ...output.written };
  };

  it("writes the document next to the definition", async () => {
    writeFileSync(join(workflows, "sample.yaml"), valid);

    await expect(run("sample")).resolves.toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "sample: wrote .aitw/workflows/sample.md\n",
    });
    const document = readFileSync(join(workflows, "sample.md"), "utf8");
    expect(document.startsWith(`${documentMarker}\n`)).toBe(true);
    expect(document).toContain('```mermaid\nflowchart TD\n  start_(("start"))');
  });

  it("supports .yml and subdirectories", async () => {
    writeFileSync(join(workflows, "release", "notes.yml"), valid);

    await expect(run("release/notes")).resolves.toMatchObject({
      exitCode: 0,
      stdout: "release/notes: wrote .aitw/workflows/release/notes.md\n",
    });
    expect(readFileSync(join(workflows, "release", "notes.md"), "utf8")).toContain("mermaid");
  });

  it("replaces a document that it generated", async () => {
    writeFileSync(join(workflows, "sample.yaml"), valid);
    writeFileSync(join(workflows, "sample.md"), `${documentMarker}\n\nold\n`);

    await expect(run("sample")).resolves.toMatchObject({ exitCode: 0 });
    expect(readFileSync(join(workflows, "sample.md"), "utf8")).not.toContain("old");
  });

  it("does not replace a file that someone wrote", async () => {
    writeFileSync(join(workflows, "sample.yaml"), valid);
    writeFileSync(join(workflows, "sample.md"), "# My notes\n");

    await expect(run("sample")).resolves.toEqual({
      exitCode: 1,
      stderr:
        ".aitw/workflows/sample.md: aitw docs did not generate this file, so it was not replaced\n",
      stdout: "",
    });
    expect(readFileSync(join(workflows, "sample.md"), "utf8")).toBe("# My notes\n");
  });

  it("reports an invalid definition and writes nothing", async () => {
    writeFileSync(join(workflows, "broken.yaml"), "version: v0\n");

    const result = await run("broken");

    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(result.stderr).toContain(".aitw/workflows/broken.yaml");
    expect(() => readFileSync(join(workflows, "broken.md"))).toThrow();
  });

  it("generates every workflow without a name, and continues after a failure", async () => {
    writeFileSync(join(workflows, "a.yaml"), valid);
    writeFileSync(join(workflows, "broken.yaml"), "version: v0\n");
    writeFileSync(join(workflows, "release", "notes.yaml"), valid);
    writeFileSync(join(workflows, "notes.txt"), "not a workflow");

    const result = await run();

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe(
      [
        "a: wrote .aitw/workflows/a.md",
        "release/notes: wrote .aitw/workflows/release/notes.md",
        "",
      ].join("\n"),
    );
    expect(result.stderr).toContain(".aitw/workflows/broken.yaml");
  });

  it("warns about a file whose name cannot be a workflow name", async () => {
    writeFileSync(join(workflows, "a.yaml"), valid);
    writeFileSync(join(workflows, "1st.yaml"), valid);

    await expect(run()).resolves.toEqual({
      exitCode: 0,
      stderr: ".aitw/workflows/1st.yaml: skipped, because it is not a valid workflow name\n",
      stdout: "a: wrote .aitw/workflows/a.md\n",
    });
  });

  it("succeeds when there are no workflows", async () => {
    await expect(run()).resolves.toEqual({ exitCode: 0, stderr: "", stdout: "" });
  });

  it("reports a directory outside of a project", async () => {
    rmSync(join(cwd, ".aitw"), { force: true, recursive: true });

    await expect(run()).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("No .aitw directory found") as unknown,
    });
  });
});
