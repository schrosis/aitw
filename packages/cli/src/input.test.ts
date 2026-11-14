import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readWorkflowInput } from "./input.ts";

describe("readWorkflowInput", () => {
  let directory: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "ugoke-input-"));
    writeFileSync(join(directory, "input.json"), '{"level": "high", "threshold": 1.5}');
    writeFileSync(join(directory, "list.json"), "[1]");
    writeFileSync(join(directory, "input.yaml"), "level: high");
  });

  afterAll(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  it("reads a JSON object", async () => {
    await expect(readWorkflowInput(' {"level": "high", "count": -2}', directory)).resolves.toEqual({
      ok: true,
      values: { count: -2, level: "high" },
    });
  });

  it("reads a JSON file relative to the current directory", async () => {
    await expect(readWorkflowInput("input.json", directory)).resolves.toEqual({
      ok: true,
      values: { level: "high", threshold: 1.5 },
    });
  });

  it.each([
    ["{ level: high }", "--input is not valid JSON"],
    ['{"threshold": 1e3}', "--input: threshold: Must be a decimal number"],
    ["input.yaml", "--input must be a JSON object or the path of a .json file: input.yaml"],
    ["list.json", "list.json must be a JSON object"],
    ["missing.json", "Failed to read missing.json"],
  ])("rejects %j", async (value, message) => {
    await expect(readWorkflowInput(value, directory)).resolves.toMatchObject({
      message: expect.stringContaining(message) as unknown,
      ok: false,
    });
  });
});
