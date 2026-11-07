import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { ScriptTimeoutError } from "@aitw/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLocalScriptRunner } from "./index.ts";

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitUntilStopped = async (pid: number): Promise<boolean> => {
  for (let attempt = 0; attempt < 50 && isRunning(pid); attempt += 1) {
    await sleep(20);
  }
  return !isRunning(pid);
};

describe("createLocalScriptRunner", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "aitw-script-")));
  });

  afterEach(() => {
    rmSync(cwd, { force: true, recursive: true });
  });

  const run = (script: string, signal = new AbortController().signal, timeoutMs = 10_000) =>
    createLocalScriptRunner({ cwd, killGraceMs: 200 }).run(
      { input: {}, run: script, timeoutMs },
      signal,
    );

  it("returns the exit code and output", async () => {
    await expect(run("echo out; echo err >&2; exit 3")).resolves.toEqual({
      exitCode: 3,
      stderr: "err\n",
      stdout: "out\n",
    });
  });

  it("stops at the first failing command", async () => {
    await expect(run("false; echo after")).resolves.toMatchObject({ exitCode: 1, stdout: "" });
  });

  it("runs in the working directory with the current environment", async () => {
    process.env.AITW_TEST_VALUE = "inherited";
    try {
      await expect(run('pwd; printf %s "$AITW_TEST_VALUE"')).resolves.toMatchObject({
        stdout: `${cwd}\ninherited`,
      });
    } finally {
      delete process.env.AITW_TEST_VALUE;
    }
  });

  it("stops child processes on timeout", async () => {
    const result = run("sleep 30 & echo $! > pid; wait", undefined, 300);

    await expect(result).rejects.toBeInstanceOf(ScriptTimeoutError);
    const pid = Number(readFileSync(join(cwd, "pid"), "utf8"));
    await expect(waitUntilStopped(pid)).resolves.toBe(true);
  });

  it("stops child processes on abort", async () => {
    const controller = new AbortController();
    const result = run("sleep 30 & echo $! > pid; wait", controller.signal);
    await sleep(300);
    controller.abort(new Error("Cancelled"));

    await expect(result).rejects.toThrow("Cancelled");
    const pid = Number(readFileSync(join(cwd, "pid"), "utf8"));
    await expect(waitUntilStopped(pid)).resolves.toBe(true);
  });

  it("kills processes that ignore SIGTERM", async () => {
    const result = run('trap "" TERM; sleep 30 & echo $! > pid; wait', undefined, 300);

    await expect(result).rejects.toBeInstanceOf(ScriptTimeoutError);
    const pid = Number(readFileSync(join(cwd, "pid"), "utf8"));
    await expect(waitUntilStopped(pid)).resolves.toBe(true);
  });

  it("stops processes left behind when the script exits", async () => {
    await expect(run("sleep 30 & echo $! > pid; exit 0", undefined, 5000)).resolves.toMatchObject({
      exitCode: 0,
    });
    const pid = Number(readFileSync(join(cwd, "pid"), "utf8"));
    await expect(waitUntilStopped(pid)).resolves.toBe(true);
  });

  it("stops detached processes left behind when the script exits", async () => {
    await expect(
      run("sleep 30 >/dev/null 2>&1 & echo $! > pid; exit 0", undefined, 5000),
    ).resolves.toMatchObject({ exitCode: 0 });
    const pid = Number(readFileSync(join(cwd, "pid"), "utf8"));
    await expect(waitUntilStopped(pid)).resolves.toBe(true);
  });

  it("kills detached processes that ignore SIGTERM after the script exits", async () => {
    await expect(
      run('trap "" TERM; sleep 30 >/dev/null 2>&1 & echo $! > pid; exit 0', undefined, 5000),
    ).resolves.toMatchObject({ exitCode: 0 });
    const pid = Number(readFileSync(join(cwd, "pid"), "utf8"));
    await expect(waitUntilStopped(pid)).resolves.toBe(true);
  });

  it("rejects an aborted signal without running the script", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Cancelled"));

    await expect(run("echo started > started", controller.signal)).rejects.toThrow("Cancelled");
    expect(() => readFileSync(join(cwd, "started"))).toThrow();
  });
});
