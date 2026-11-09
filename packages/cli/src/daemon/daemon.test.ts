import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";

// These tests run the built executable, so they depend on `pnpm build`.
const bin = fileURLToPath(new URL("../../dist/bin.js", import.meta.url));

describe("aitw daemon", () => {
  let state: string;

  beforeEach(() => {
    // A short directory keeps the socket path within the limit of the platform.
    state = mkdtempSync("/tmp/aitw-daemon-");
  });

  /** Stops processes that use the state of the test, such as a development server. */
  const stopLeftovers = (): void => {
    try {
      execFileSync("pkill", ["-f", "--", `--db-filename ${join(state, "temporal.db")}`]);
    } catch {
      // No process was left.
    }
  };

  afterEach(async () => {
    await execute(["daemon", "stop"]);
    stopLeftovers();
    rmSync(state, { force: true, recursive: true });
  });

  const execute = async (args: string[]) =>
    new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [bin, ...args], {
        env: { ...process.env, XDG_STATE_HOME: state },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("exit", (exitCode) => resolve({ exitCode, stderr, stdout }));
    });

  const start = async () =>
    execute([
      "daemon",
      "start",
      "--dev",
      "--dev-db",
      join(state, "temporal.db"),
      "--temporal-bin",
      inject("temporalCli"),
    ]);

  it("starts, reports, and stops the resident process", async () => {
    await expect(execute(["daemon", "status"])).resolves.toMatchObject({
      exitCode: 1,
      stdout: "aitw daemon: not running\n",
    });

    const started = await start();
    expect(started).toMatchObject({ exitCode: 0 });
    expect(started.stdout).toMatch(
      /^aitw daemon: started \(pid \d+, server 127\.0\.0\.1:\d+, aitw \d+\.\d+\.\d+\)\n$/u,
    );
    await expect(start()).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringMatching(/^aitw daemon: already running \(pid \d+/u) as unknown,
    });

    const status = await execute(["daemon", "status"]);
    expect(status).toMatchObject({ exitCode: 0 });
    expect(status.stdout).toContain("aitw daemon: running (pid ");
    expect(status.stdout).toContain(`log: ${join(state, "aitw", "daemon", "daemon.log")}\n`);

    await expect(execute(["daemon", "stop"])).resolves.toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "aitw daemon: stopped\n",
    });
    await expect(execute(["daemon", "status"])).resolves.toMatchObject({ exitCode: 1 });
    await expect(execute(["daemon", "stop"])).resolves.toMatchObject({
      exitCode: 0,
      stdout: "aitw daemon: not running\n",
    });
  }, 60_000);

  it("starts again after the resident process was killed", async () => {
    await start();
    const pid = Number(readFileSync(join(state, "aitw", "daemon", "daemon.lock"), "utf8"));
    // Without a graceful stop, the lock and the socket stay behind.
    process.kill(pid, "SIGKILL");

    await expect(start()).resolves.toMatchObject({ exitCode: 0 });
    // The killed process could not stop its development server.
    stopLeftovers();
  }, 60_000);

  it("needs --dev-db with --dev", async () => {
    await expect(execute(["daemon", "start", "--dev"])).resolves.toMatchObject({
      exitCode: 1,
      stderr:
        "aitw daemon needs --dev-db with --dev, because a development server without it keeps no runs\n",
    });
  });
});
