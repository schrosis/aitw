import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { validate } from "./validate.ts";

const validSource = `version: v0.1
start: fetch
steps:
  fetch:
    type: script
    run: ./fetch.sh
    next: end
`;

describe("validate", () => {
  let directory: string;
  let stdout: string;
  let stderr: string;
  const output = {
    stderr: (text: string) => {
      stderr += text;
    },
    stdout: (text: string) => {
      stdout += text;
    },
  };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "aitw-validate-"));
    stdout = "";
    stderr = "";
  });

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  const write = (source: string): string => {
    const file = join(directory, "workflow.yaml");
    writeFileSync(file, source);
    return file;
  };

  it("reports a valid definition", async () => {
    const file = write(validSource);

    await expect(validate(file, output)).resolves.toBe(0);
    expect(stdout).toBe(`${file}: valid\n`);
    expect(stderr).toBe("");
  });

  it("reports schema errors before transition errors", async () => {
    const file = write(validSource.replace("next: end", "next: report").replace("v0.1", "v9"));

    await expect(validate(file, output)).resolves.toBe(1);
    expect(stderr.split("\n").filter(Boolean)).toEqual([
      `${file}:1:10 version: Invalid input: expected "v0.1"`,
    ]);
    expect(stdout).toBe("");
  });

  it("reports a transition error", async () => {
    const file = write(validSource.replace("next: end", "next: report"));

    await expect(validate(file, output)).resolves.toBe(1);
    expect(stderr).toBe(`${file}:7:11 steps.fetch.next: Unknown step: report\n`);
  });

  it("reports a missing file", async () => {
    const file = join(directory, "missing.yaml");

    await expect(validate(file, output)).resolves.toBe(1);
    expect(stderr).toMatch(new RegExp(`^${file}: ENOENT`, "u"));
  });
});
