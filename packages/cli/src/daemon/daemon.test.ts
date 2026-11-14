import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";

import { fixtureProject } from "../testing.ts";

// These tests run the built executable, so they depend on `pnpm build`.
const bin = fileURLToPath(new URL("../../dist/bin.js", import.meta.url));

describe("aitw daemon", () => {
  let state: string;

  beforeEach(() => {
    // A short directory keeps the socket path within the limit of the platform.
    state = mkdtempSync("/tmp/aitw-daemon-");
  });

  /** SQLite file that the resident process keeps its runs in by default. */
  const defaultDb = (): string => join(state, "aitw", "temporal.db");

  /**
   * Pattern of the command line of the development server of the test.
   *
   * The resident process names the file by its real path, and /tmp is a link on macOS, so the
   * pattern starts at the directory of the test.
   */
  const devServerPattern = (): string => `--db-filename .*${basename(state)}/aitw/temporal\\.db`;

  /** Returns the process IDs of the development servers that use the SQLite file of the test. */
  const devServers = (): string[] => {
    try {
      return execFileSync("pgrep", ["-f", "--", devServerPattern()], {
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .filter((line) => line !== "");
    } catch {
      return [];
    }
  };

  /** Returns every progress event that the runs of the test stored, as JSON Lines. */
  const runEvents = (): string => {
    const logs = join(state, "aitw", "logs");
    try {
      return readdirSync(logs, { recursive: true })
        .map(String)
        .filter((file) => file.endsWith("events.jsonl"))
        .map((file) => readFileSync(join(logs, file), "utf8"))
        .join("");
    } catch {
      return "";
    }
  };

  /** Stops processes that use the state of the test, such as a development server. */
  const stopLeftovers = (): void => {
    try {
      execFileSync("pkill", ["-f", "--", devServerPattern()]);
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

  const start = async () => execute(["daemon", "start", "--temporal-bin", inject("temporalCli")]);

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
    // The development server keeps its runs in the state directory, which only the owner reads.
    expect(devServers()).toHaveLength(1);
    expect(statSync(defaultDb()).mode & 0o777).toBe(0o600);
    await expect(start()).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringMatching(/^aitw daemon: already running \(pid \d+/u) as unknown,
    });

    const status = await execute(["daemon", "status"]);
    expect(status).toMatchObject({ exitCode: 0 });
    expect(status.stdout).toContain("aitw daemon: running (pid ");
    expect(status.stdout).toContain(
      `log: ${join(realpathSync(state), "aitw", "daemon", "daemon.log")}\n`,
    );
    // The Web UI starts only with --dev-ui.
    expect(status.stdout).not.toContain("web ui:");

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
    // The new process stopped the development server of the killed one, which used the same
    // SQLite file.
    expect(devServers()).toHaveLength(1);
    expect(readFileSync(join(state, "aitw", "daemon", "daemon.log"), "utf8")).toContain(
      "stopping the development server that was left running",
    );
  }, 60_000);

  it("runs the steps of a run that aitw run detached", async () => {
    await start();
    const run = await new Promise<{ exitCode: number | null; output: string }>((resolve) => {
      const child = spawn(process.execPath, [bin, "run", "run-detach"], {
        cwd: fixtureProject,
        env: { ...process.env, XDG_STATE_HOME: state },
      });
      let output = "";
      let interrupted = false;
      const collect = (chunk: Buffer): void => {
        output += chunk.toString();
        // Interrupt once the script runs, which the resident process runs. A second interrupt
        // would exit at once.
        if (!interrupted && output.includes("sleep 2 && echo built\n")) {
          interrupted = true;
          child.kill("SIGINT");
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("exit", (exitCode) => resolve({ exitCode, output }));
    });

    // aitw run detached at once, because the resident process runs the script.
    expect(run.exitCode).toBe(3);
    expect(run.output).not.toContain("Waiting for the running step");
    expect(run.output).toContain('run-detach: detached. Run "aitw attach" to continue\n');

    // The resident process finishes the run in the background.
    const finished = '"outcome":"succeeded","step":"report","type":"stepFinished"';
    for (let attempt = 0; attempt < 100 && !runEvents().includes(finished); attempt += 1) {
      await sleep(100);
    }
    expect(runEvents()).toContain(finished);

    const status = await execute(["daemon", "status"]);
    expect(status.stdout).toContain(`projects:\n  ${realpathSync(fixtureProject)}\n`);
  }, 60_000);

  it("warns when the running process uses other options", async () => {
    await start();

    const again = await execute(["daemon", "start", "--address", "localhost:7233"]);

    expect(again).toMatchObject({ exitCode: 0 });
    expect(again.stderr).toMatch(
      /^aitw daemon: it uses the server options "--dev --dev-db \S+ --temporal-bin \S+"\. Run "aitw daemon stop" and start it again to change it\n$/u,
    );
  }, 60_000);

  it("warns only when the running process uses other options, including --dev-ui", async () => {
    const options = [
      "daemon",
      "start",
      // A path that needs quotes on a command line.
      "--dev-db",
      join(state, "temporal db.sqlite"),
      "--temporal-bin",
      inject("temporalCli"),
    ];
    await execute(options);

    await expect(execute(options)).resolves.toMatchObject({ exitCode: 0, stderr: "" });
    await execute(["daemon", "stop"]);

    // --dev-ui reaches the resident process, and is compared with the request.
    await execute([...options, "--dev-ui"]);
    await expect(execute([...options, "--dev-ui"])).resolves.toMatchObject({
      exitCode: 0,
      stderr: "",
    });
    const status = await execute(["daemon", "status"]);
    expect(status.stdout).toMatch(/^web ui: http:\/\/127\.0\.0\.1:\d+$/mu);
    await expect(execute(options)).resolves.toMatchObject({
      stderr: expect.stringContaining('--dev-ui". Run "aitw daemon stop"') as unknown,
    });
    await execute(["daemon", "stop"]);
    try {
      execFileSync("pkill", ["-f", "--", `--db-filename ${join(state, "temporal db.sqlite")}`]);
    } catch {
      // No process was left.
    }
  }, 60_000);

  it("does not take options of a development server with --address", async () => {
    await expect(
      execute(["daemon", "start", "--address", "localhost:7233", "--dev-db", "state.db"]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("cannot be used with") as unknown,
    });
  });

  it("tells how to choose a server when no resident process runs", async () => {
    const run = await new Promise<{ exitCode: number | null; output: string }>((resolve) => {
      const child = spawn(process.execPath, [bin, "run", "run-success"], {
        cwd: fixtureProject,
        env: { ...process.env, XDG_STATE_HOME: state },
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.on("exit", (exitCode) => resolve({ exitCode, output }));
    });

    expect(run).toEqual({
      exitCode: 1,
      output:
        'run-success: failed: aitw daemon is not running. Run "aitw daemon start", choose a server with --dev or --address, or set temporal.address in .aitw/config.yaml\n',
    });
  });
});
