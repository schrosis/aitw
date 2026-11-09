import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { CommandContext } from "../commands/load.js";
import type { ServerOptions } from "../server.js";
import { getDaemonStatus, requestDaemonStop } from "./client.js";
import type { DaemonStatus } from "./client.js";
import { checkSocketPath, daemonPaths } from "./paths.js";

/** Time to wait for the resident process to start or stop, in milliseconds. */
const waitTimeoutMs = 60_000;

/** Options of {@link startDaemon}. */
export interface StartDaemonOptions {
  server: ServerOptions;
  /** Path of the aitw executable that runs the resident process. */
  executable: string;
}

/** Returns the arguments of `aitw daemon run` that reach the same server. */
const serverArguments = (server: ServerOptions, cwd: string): string[] => {
  if (server.type === "address") {
    return ["--address", server.address];
  }
  return [
    "--dev",
    // The resident process may run in another directory, so the path is made absolute.
    ...(server.dbFilename === undefined ? [] : ["--dev-db", resolve(cwd, server.dbFilename)]),
    ...(server.temporalBin === undefined ? [] : ["--temporal-bin", server.temporalBin]),
  ];
};

/** Returns the end of the log, to explain why the resident process did not start. */
const logTail = (file: string): string => {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-10).join("\n");
  } catch {
    return "";
  }
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const describe = ({ address, pid, version }: DaemonStatus): string =>
  `pid ${pid}, server ${address}, aitw ${version}`;

/**
 * Starts the resident process of this host in the background.
 *
 * @returns The exit code of the command.
 */
export const startDaemon = async (
  { executable, server }: StartDaemonOptions,
  context: CommandContext,
): Promise<number> => {
  const paths = daemonPaths();
  checkSocketPath(paths.socket);
  if (server.type === "dev" && server.dbFilename === undefined) {
    context.stderr(
      "aitw daemon needs --dev-db with --dev, because a development server without it keeps no runs\n",
    );
    return 1;
  }
  const running = await getDaemonStatus(paths);
  if (running !== undefined) {
    context.stdout(`aitw daemon: already running (${describe(running)})\n`);
    return 0;
  }

  mkdirSync(paths.directory, { mode: 0o700, recursive: true });
  const logFile = openSync(paths.log, "a", 0o600);
  let exited: number | null | undefined;
  try {
    const child = spawn(
      process.execPath,
      [executable, "daemon", "run", ...serverArguments(server, context.cwd)],
      // The resident process outlives the terminal, so it has its own session and no terminal.
      { cwd: context.cwd, detached: true, stdio: ["ignore", logFile, logFile] },
    );
    child.once("exit", (code) => {
      exited = code;
    });
    child.unref();
  } finally {
    closeSync(logFile);
  }

  const deadline = Date.now() + waitTimeoutMs;
  while (Date.now() < deadline) {
    const status = await getDaemonStatus(paths).catch(() => undefined);
    if (status !== undefined) {
      context.stdout(`aitw daemon: started (${describe(status)})\n`);
      return 0;
    }
    if (exited !== undefined) {
      const tail = logTail(paths.log);
      context.stderr(`aitw daemon: failed to start${tail === "" ? "" : `:\n${tail}`}\n`);
      return 1;
    }
    await sleep(100);
  }
  context.stderr(
    `aitw daemon: did not start within ${waitTimeoutMs / 1000} seconds. See ${paths.log}\n`,
  );
  return 1;
};

/**
 * Stops the resident process of this host, and waits for it to exit.
 *
 * @returns The exit code of the command.
 */
export const stopDaemon = async (context: CommandContext): Promise<number> => {
  const paths = daemonPaths();
  const status = await getDaemonStatus(paths);
  if (status === undefined) {
    context.stdout("aitw daemon: not running\n");
    return 0;
  }
  await requestDaemonStop(paths);
  const deadline = Date.now() + waitTimeoutMs;
  while (isAlive(status.pid)) {
    if (Date.now() > deadline) {
      context.stderr(
        `aitw daemon: did not stop within ${waitTimeoutMs / 1000} seconds (pid ${status.pid})\n`,
      );
      return 1;
    }
    await sleep(100);
  }
  context.stdout("aitw daemon: stopped\n");
  return 0;
};

/**
 * Shows the state of the resident process of this host.
 *
 * @returns The exit code of the command: 0 when it runs, and 1 when it does not.
 */
export const showDaemonStatus = async (context: CommandContext): Promise<number> => {
  const paths = daemonPaths();
  const status = await getDaemonStatus(paths);
  if (status === undefined) {
    context.stdout("aitw daemon: not running\n");
    return 1;
  }
  context.stdout(
    [
      `aitw daemon: running (${describe(status)})`,
      `started: ${status.startedAt}`,
      `log: ${paths.log}`,
      "",
    ].join("\n"),
  );
  return 0;
};
