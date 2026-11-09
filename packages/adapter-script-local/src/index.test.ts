import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

const runWithEnv = async (
  cwd: string,
  request: { env?: Record<string, string>; dotenv?: string },
  script: string,
) =>
  createLocalScriptRunner({ cwd }).run(
    { inputs: {}, run: script, timeoutMs: 10_000, ...request },
    { signal: new AbortController().signal },
  );

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
      { inputs: {}, run: script, timeoutMs },
      { signal },
    );

  it("stops running scripts when the process exits", async () => {
    // A separate process runs a script and exits without stopping it.
    const program = `
      import { createLocalScriptRunner } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
      createLocalScriptRunner({ cwd: ${JSON.stringify(cwd)} }).run(
        { inputs: {}, run: "echo $$ > pid; exec sleep 30", timeoutMs: 60_000 },
        { signal: new AbortController().signal },
      );
      const wait = async () => {
        for (;;) {
          try {
            if ((await import("node:fs")).readFileSync("pid", "utf8").endsWith("\\n")) return;
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      };
      process.chdir(${JSON.stringify(cwd)});
      await wait();
      process.exit(0);
    `;
    execFileSync(process.execPath, ["--input-type=module", "-e", program]);

    const pid = Number(readFileSync(join(cwd, "pid"), "utf8"));
    await expect(waitUntilStopped(pid)).resolves.toBe(true);
  });

  it("registers one exit listener for every script", async () => {
    const runner = createLocalScriptRunner({ cwd });
    const before = process.listenerCount("exit");
    await Promise.all(
      Array.from({ length: 12 }, async () =>
        runner.run(
          { inputs: {}, run: "true", timeoutMs: 10_000 },
          { signal: new AbortController().signal },
        ),
      ),
    );

    expect(process.listenerCount("exit") - before).toBeLessThanOrEqual(1);
  });

  describe("environment", () => {
    it("sets the variables of the definition over the inherited ones, and dotenv under them", async () => {
      writeFileSync(join(cwd, ".env"), "FROM_DOTENV=dotenv\nHOME=from-dotenv\nSET=from-dotenv\n");

      const result = await runWithEnv(
        cwd,
        { dotenv: ".env", env: { HOME: "from-env", SET: "from-env" } },
        'printf "%s %s %s %s" "$FROM_DOTENV" "$SET" "$HOME" "$PATH"',
      );

      const [fromDotenv, set, home, path] = result.stdout.split(" ");
      expect(fromDotenv).toBe("dotenv");
      expect(set).toBe("from-env");
      expect(home).toBe("from-env");
      // An inherited variable is kept over dotenv.
      expect(path).toBe(process.env.PATH);
    });

    it("reads a file in the root whose name starts with two dots", async () => {
      writeFileSync(join(cwd, "..env"), "DOTS=yes\n");

      const result = await runWithEnv(cwd, { dotenv: "..env" }, 'printf "%s" "$DOTS"');

      expect(result.stdout).toBe("yes");
    });

    it("does not let dotenv replace an inherited variable", async () => {
      writeFileSync(join(cwd, ".env"), "HOME=from-dotenv\n");

      const result = await runWithEnv(cwd, { dotenv: ".env" }, 'printf "%s" "$HOME"');

      expect(result.stdout).toBe(process.env.HOME);
    });

    it("passes a value without running it", async () => {
      const result = await runWithEnv(
        cwd,
        { env: { TITLE: "'; echo injected; echo '" } },
        'printf "%s" "$TITLE"',
      );

      expect(result.stdout).toBe("'; echo injected; echo '");
    });

    it("fails without running the script when the dotenv file is missing", async () => {
      await expect(runWithEnv(cwd, { dotenv: "missing.env" }, "touch ran")).rejects.toThrow(
        "Failed to read the dotenv file missing.env",
      );
      expect(existsSync(join(cwd, "ran"))).toBe(false);
    });

    it("does not read a dotenv file outside of the working directory through a link", async () => {
      const outside = mkdtempSync(join(tmpdir(), "aitw-outside-"));
      try {
        writeFileSync(join(outside, "secrets.env"), "SECRET=x\n");
        symlinkSync(join(outside, "secrets.env"), join(cwd, ".env"));

        await expect(runWithEnv(cwd, { dotenv: ".env" }, "true")).rejects.toThrow(
          "it is outside of the project root",
        );
      } finally {
        rmSync(outside, { force: true, recursive: true });
      }
    });
  });

  it("returns the exit code and output", async () => {
    await expect(run("echo out; echo err >&2; exit 3")).resolves.toEqual({
      exitCode: 3,
      signal: null,
      stderr: "err\n",
      stdout: "out\n",
    });
  });

  it("reports a signal that stopped the script", async () => {
    await expect(run("kill -TERM $$")).resolves.toMatchObject({
      exitCode: null,
      signal: "SIGTERM",
    });
  });

  it("streams output as the script writes it", async () => {
    const chunks: string[] = [];
    await createLocalScriptRunner({ cwd }).run(
      { inputs: {}, run: "echo out; echo err >&2", timeoutMs: 10_000 },
      {
        onOutput: ({ stream, text }) => chunks.push(`${stream}:${text}`),
        signal: new AbortController().signal,
      },
    );

    expect(chunks.toSorted()).toEqual(["stderr:err\n", "stdout:out\n"]);
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
