import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { GhRunnerOptions } from "./gh.ts";
import { createGhRunner } from "./gh.ts";
import { GithubSourceError } from "./source.ts";

// A gh of the tests, so that no test runs gh of the user or uses its login.
const fakeGh = `#!/bin/sh
dir=$(dirname "$0")
echo $$ > "$dir/pid"
case "$1" in
  args)
    shift
    printf '%s\\0' "$@"
    ;;
  env)
    printf '%s\\n' "$GH_PROMPT_DISABLED" "$GH_NO_UPDATE_NOTIFIER" "$NO_COLOR" "$FROM_WORKER"
    ;;
  stdin)
    cat
    echo "read the standard input"
    ;;
  fail)
    echo "  some output"
    echo "gh: Something failed" >&2
    exit 3
    ;;
  large)
    head -c 4096 /dev/zero
    ;;
  orphan)
    # Leaves a process that holds the standard output open after gh exits.
    sleep 30 &
    echo $! > "$dir/orphan"
    ;;
  hang)
    trap 'echo stopped > "$dir/stopped"; kill "$child" 2>/dev/null; exit 143' TERM
    sleep 30 > /dev/null 2>&1 &
    child=$!
    # Tests send signals only after the trap is set.
    echo $$ > "$dir/ready"
    wait "$child"
    ;;
esac
`;

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ugoke-gh-"));
  const gh = join(directory, "gh");
  writeFileSync(gh, fakeGh);
  chmodSync(gh, 0o755);
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

const runner = (options: GhRunnerOptions = {}) =>
  createGhRunner({
    env: { FROM_WORKER: "yes", PATH: `${directory}:/usr/bin:/bin` },
    ...options,
  });

const neverAborted = (): AbortSignal => new AbortController().signal;

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Waits until the fake gh is ready for signals, and returns its process ID. */
const waitUntilReady = async (): Promise<number> => {
  const file = join(directory, "ready");
  while (!existsSync(file) || readFileSync(file, "utf8").trim() === "") {
    // oxlint-disable-next-line no-await-in-loop -- The file is checked again after each wait.
    await sleep(10);
  }
  return Number(readFileSync(file, "utf8").trim());
};

describe("createGhRunner", () => {
  it("passes the arguments as they are, without a shell", async () => {
    const args = [
      "query=query ($owner: String!) {\n  repository(owner: $owner) { url }\n}",
      "owner=a b",
      "name=$(touch hacked); `touch hacked` | > hacked",
      "",
      "*",
    ];

    const result = await runner()(["args", ...args], neverAborted());

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: `${args.join("\0")}\0` });
    expect(existsSync(join(directory, "hacked"))).toBe(false);
  });

  it("adds variables that keep gh quiet to the environment of the Worker", async () => {
    const result = await runner()(["env"], neverAborted());

    expect(result.stdout).toBe("1\n1\n1\nyes\n");
  });

  it("closes the standard input", async () => {
    const result = await runner()(["stdin"], neverAborted());

    expect(result.stdout).toBe("read the standard input\n");
  });

  it("returns the exit code and both outputs of gh", async () => {
    const result = await runner()(["fail"], neverAborted());

    expect(result).toEqual({
      exitCode: 3,
      stderr: "gh: Something failed\n",
      stdout: "  some output\n",
    });
  });

  it("stops gh when the signal is aborted, and fails after gh exits", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const running = runner()(["hang"], controller.signal);
    const pid = await waitUntilReady();

    controller.abort(reason);

    await expect(running).rejects.toBe(reason);
    expect(readFileSync(join(directory, "stopped"), "utf8")).toBe("stopped\n");
    expect(isRunning(pid)).toBe(false);
  });

  it("does not run gh when the signal is already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);

    await expect(runner()(["args"], controller.signal)).rejects.toBe(reason);
    expect(existsSync(join(directory, "pid"))).toBe(false);
  });

  it("stops gh that takes too long as a transient error", async () => {
    // The limit can stop gh before it sets its trap, so only what holds in either case is checked.
    // The abort test checks that gh can handle SIGTERM.
    const error: unknown = await runner({ timeoutMs: 200 })(["hang"], neverAborted()).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(GithubSourceError);
    expect(error).toMatchObject({
      kind: "transient",
      message: "Could not reach GitHub: gh did not finish within 0.2 seconds",
    });
    // The run fails only after gh exits.
    const pidFile = join(directory, "pid");
    const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : undefined;
    expect(pid === undefined || !isRunning(pid)).toBe(true);
  });

  it("fails at the limit when gh has exited and a process that it left holds the output", async () => {
    try {
      const error: unknown = await runner({ timeoutMs: 300 })(["orphan"], neverAborted()).catch(
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(GithubSourceError);
      expect(error).toMatchObject({ kind: "transient" });
    } finally {
      const orphanFile = join(directory, "orphan");
      if (existsSync(orphanFile)) {
        try {
          process.kill(Number(readFileSync(orphanFile, "utf8").trim()), "SIGKILL");
        } catch {
          // The process has already exited.
        }
      }
    }
  });

  it("stops gh whose output is too large as a fatal error", async () => {
    const error: unknown = await runner({ maxOutputBytes: 1024 })(["large"], neverAborted()).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(GithubSourceError);
    expect(error).toMatchObject({
      kind: "fatal",
      message: "The output of gh is larger than 1024 bytes, the most that is read",
    });
  });

  it("tells how to find gh when it is not in the PATH", async () => {
    const run = createGhRunner({ env: { PATH: join(directory, "missing") } });

    const error: unknown = await run(["args"], neverAborted()).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(GithubSourceError);
    expect(error).toMatchObject({
      kind: "fatal",
      message:
        "gh was not found in the PATH of the Worker. The resident process uses the environment where ugoke daemon start ran; install gh there, or restart the resident process from a shell whose PATH has gh",
    });
  });
});
