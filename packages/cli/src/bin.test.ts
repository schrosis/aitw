import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fixtureProject } from "./testing.ts";

// These tests run the built executable, so they depend on `pnpm build`.
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

/** Runs the executable and reports whether it exits by itself. */
const execute = async (args: string[], cwd: string) =>
  new Promise<{ exitCode: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`aitw ${args.join(" ")} did not exit: ${output}`));
    }, 10_000);
    child.on("exit", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, output });
    });
  });

describe("aitw executable", () => {
  let outside: string;

  beforeAll(() => {
    outside = realpathSync(mkdtempSync(join(tmpdir(), "aitw-no-project-")));
  });

  afterAll(() => {
    rmSync(outside, { force: true, recursive: true });
  });

  it.each([
    ["validate", "missing"],
    ["run", "missing"],
  ])(
    "exits after %s fails outside a project",
    async (...args) => {
      await expect(execute(args, outside)).resolves.toMatchObject({ exitCode: 1 });
    },
    20_000,
  );

  it("exits after validate succeeds", async () => {
    await expect(execute(["validate", "valid"], fixtureProject)).resolves.toEqual({
      exitCode: 0,
      output: "valid: valid\n",
    });
  }, 20_000);
});
