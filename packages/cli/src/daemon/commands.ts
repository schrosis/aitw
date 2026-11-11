import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { CommandContext } from "../commands/load.js";
import { workflowCodeVersion } from "@aitw/engine";

import { quote, serverArguments } from "../server.js";
import type { ServerOptions } from "../server.js";
import { stateDirectory } from "../state.js";
import { getDaemonStatus, requestDaemonStop } from "./client.js";
import type { DaemonStatus } from "./client.js";
import { checkSocketPath, daemonPaths } from "./paths.js";

/** Time to wait for the resident process to start or stop, in milliseconds. */
const waitTimeoutMs = 60_000;

/** Options of {@link startDaemon}. */
export interface StartDaemonOptions {
  /**
   * Temporal Server of the resident process. A development server without a SQLite file keeps
   * its runs in the state directory.
   */
  server: ServerOptions;
  /** Version of this aitw, to tell whether a running resident process differs. */
  version: string;
  /** Path of the aitw executable that runs the resident process. */
  executable: string;
}

/**
 * Returns the server options with absolute paths, because the resident process runs in the state
 * directory.
 */
const withAbsolutePaths = (server: ServerOptions, cwd: string): ServerOptions =>
  server.type === "address"
    ? server
    : {
        ...server,
        dbFilename: server.dbFilename === undefined ? undefined : resolve(cwd, server.dbFilename),
        temporalBin:
          server.temporalBin?.includes("/") === true
            ? resolve(cwd, server.temporalBin)
            : server.temporalBin,
      };

/** Returns how a running resident process differs from the one that a command asks for. */
const differences = (running: DaemonStatus, version: string, requested: string[]): string[] => {
  const notes: string[] = [];
  if (running.version !== version || running.workflowCodeVersion !== workflowCodeVersion) {
    notes.push(`it runs aitw ${running.version}, and this is aitw ${version}`);
  }
  const runningOptions = running.serverOptions.trim();
  // The running process quotes its options for a command line, so the request is quoted too.
  if (runningOptions !== requested.map(quote).join(" ")) {
    notes.push(`it uses the server options "${runningOptions}"`);
  }
  return notes;
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
  { executable, server, version }: StartDaemonOptions,
  context: CommandContext,
): Promise<number> => {
  const paths = daemonPaths();
  checkSocketPath(paths.socket);
  // The resident process serves runs that last, so its development server always keeps them.
  const kept: ServerOptions =
    server.type === "dev" && server.dbFilename === undefined
      ? { ...server, dbFilename: join(stateDirectory(), "temporal.db") }
      : server;
  const requested = serverArguments(withAbsolutePaths(kept, context.cwd));
  const running = await getDaemonStatus(paths);
  if (running !== undefined) {
    context.stdout(`aitw daemon: already running (${describe(running)})\n`);
    const notes = differences(running, version, requested);
    if (notes.length > 0) {
      context.stderr(
        `aitw daemon: ${notes.join(", and ")}. Run "aitw daemon stop" and start it again to change it\n`,
      );
    }
    return 0;
  }

  mkdirSync(paths.directory, { mode: 0o700, recursive: true });
  const logFile = openSync(paths.log, "a", 0o600);
  let exited: number | null | undefined;
  try {
    const child = spawn(
      process.execPath,
      [executable, "daemon", "run", ...requested],
      // The resident process outlives the terminal, so it has its own session and no terminal.
      // It runs in the state directory, so that it does not hold a project directory.
      { cwd: paths.directory, detached: true, stdio: ["ignore", logFile, logFile] },
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
  // It may still start, such as after downloading the Temporal CLI on a slow network.
  context.stderr(
    `aitw daemon: did not answer within ${waitTimeoutMs / 1000} seconds, and may still be starting. Run "aitw daemon status" later, or see ${paths.log}\n`,
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
      ...(status.uiUrl === undefined ? [] : [`web ui: ${status.uiUrl}`]),
      ...(status.projects.length === 0
        ? ["projects: none"]
        : [
            "projects:",
            ...status.projects.map(({ address, previousAddresses = [], root, running }) => {
              const notes = [
                ...(address === undefined || address === status.address
                  ? []
                  : [`server ${address}`]),
                ...previousAddresses.map((previous) => `previous server ${previous}`),
                ...(running === false ? ["Worker not running"] : []),
              ];
              return `  ${root}${notes.length === 0 ? "" : ` (${notes.join(", ")})`}`;
            }),
          ]),
      "",
    ].join("\n"),
  );
  return 0;
};
