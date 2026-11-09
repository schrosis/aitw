import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { fixtureProject } from "./testing.ts";

interface ExecuteOptions {
  env?: NodeJS.ProcessEnv;
  onOutput?: (child: ChildProcess, output: string) => void;
  timeoutMs?: number;
}

// These tests run the built executable, so they depend on `pnpm build`.
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

/**
 * Runs the executable and reports whether it exits by itself.
 *
 * @param onOutput Receives the child process and the output so far, such as to interrupt it.
 */
const execute = async (
  args: string[],
  cwd: string,
  { env = process.env, onOutput = () => {}, timeoutMs = 10_000 }: ExecuteOptions = {},
) =>
  new Promise<{ exitCode: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, env });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      onOutput(child, output);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      onOutput(child, output);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`aitw ${args.join(" ")} did not exit: ${output}`));
    }, timeoutMs);
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

  it("exits when the Temporal Server cannot be reached", async () => {
    // Port 1 is reserved and nothing listens on it.
    await expect(
      execute(["run", "valid", "--address", "127.0.0.1:1"], fixtureProject),
    ).resolves.toMatchObject({ exitCode: 1 });
  }, 20_000);

  it("exits after validate succeeds", async () => {
    await expect(execute(["validate", "valid"], fixtureProject)).resolves.toEqual({
      exitCode: 0,
      output: "valid: valid\n",
    });
  }, 20_000);

  describe("with a development server", () => {
    const executable = inject("temporalCli");

    it("runs a workflow on a temporary server", async () => {
      const { exitCode, output } = await execute(
        ["run", "run-success", "--dev", "--temporal-bin", executable],
        fixtureProject,
        {
          timeoutMs: 30_000,
        },
      );

      expect(exitCode).toBe(0);
      // The Web UI starts only with --dev-ui.
      expect(output).not.toContain("Temporal Web UI");
      expect(output).toContain("run-success: completed (check, finish)\n");
    }, 40_000);

    it("finds a Temporal CLI name in PATH", async () => {
      const directory = mkdtempSync(join(tmpdir(), "aitw-path-"));
      try {
        symlinkSync(executable, join(directory, "temporal"));
        const { exitCode, output } = await execute(
          ["run", "run-success", "--dev", "--temporal-bin", "temporal"],
          fixtureProject,
          {
            env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` },
            timeoutMs: 30_000,
          },
        );

        expect(exitCode).toBe(0);
        expect(output).toContain("run-success: completed (check, finish)\n");
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    }, 40_000);

    it("cancels the run and stops the server when interrupted while waiting", async () => {
      let address: string | undefined;
      const { exitCode, output } = await execute(
        ["run", "wait-valid", "--dev", "--dev-ui", "--temporal-bin", executable],
        fixtureProject,
        {
          onOutput: (child, text) => {
            if (address === undefined && text.includes("name (string, required): ")) {
              address = /Temporal Web UI: (http:\S+)/u.exec(text)?.[1];
              child.kill("SIGINT");
            }
          },
          timeoutMs: 30_000,
        },
      );

      expect(exitCode).toBe(130);
      expect(output).toContain("■ ask: cancelled");
      expect(output).toContain(
        "wait-valid: cancelled. Runs on a development server without --dev-db cannot be resumed\n",
      );
      expect(address).toBeDefined();
      await expect(fetch(address ?? "")).rejects.toThrow();
    }, 40_000);

    it("stops the server when interrupted twice", async () => {
      let address: string | undefined;
      const { exitCode } = await execute(
        ["run", "run-sleep", "--dev", "--dev-ui", "--temporal-bin", executable],
        fixtureProject,
        {
          onOutput: (child, text) => {
            if (address === undefined && text.includes("▶ wait")) {
              address = /Temporal Web UI: (http:\S+)/u.exec(text)?.[1];
              child.kill("SIGINT");
              child.kill("SIGINT");
            }
          },
          timeoutMs: 30_000,
        },
      );

      expect(exitCode).toBe(130);
      expect(address).toBeDefined();
      await expect(fetch(address ?? "")).rejects.toThrow();
    }, 40_000);

    it("cancels the run and stops the server when interrupted", async () => {
      let address: string | undefined;
      const { exitCode, output } = await execute(
        ["run", "run-sleep", "--dev", "--dev-ui", "--temporal-bin", executable],
        fixtureProject,
        {
          onOutput: (child, text) => {
            if (address === undefined && text.includes("▶ wait")) {
              address = /Temporal Web UI: (http:\S+)/u.exec(text)?.[1];
              child.kill("SIGINT");
            }
          },
          timeoutMs: 30_000,
        },
      );

      expect(exitCode).toBe(130);
      expect(output).toContain(
        "run-sleep: cancelled. Runs on a development server without --dev-db cannot be resumed\n",
      );
      expect(address).toBeDefined();
      await expect(fetch(address ?? "")).rejects.toThrow();
    }, 40_000);
  });

  it.each([
    [["--dev", "--address", "localhost:7233"], "cannot be used with"],
    [["--dev-db", "state.db"], "require --dev"],
    [["--dev-ui"], "require --dev"],
    [["--temporal-bin", "temporal"], "require --dev"],
  ])(
    "rejects the server options %j",
    async (options, message) => {
      const { exitCode, output } = await execute(["run", "valid", ...options], fixtureProject);

      expect(exitCode).toBe(1);
      expect(output).toContain(message);
    },
    20_000,
  );
});
