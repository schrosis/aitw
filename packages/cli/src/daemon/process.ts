import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { workflowCodeVersion } from "@aitw/engine";

import type { CommandContext } from "../commands/load.js";
import { acquireRunLock, RunLockedError } from "../lock.js";
import { openServer } from "../server.js";
import type { OpenedServer, ServerOptions } from "../server.js";
import { getDaemonStatus } from "./client.js";
import type { DaemonStatus } from "./client.js";
import { checkSocketPath, daemonPaths } from "./paths.js";
import { createProjectWorkers } from "./workers.js";
import type { ProjectWorkers } from "./workers.js";

/** Options of {@link runDaemon}. */
export interface RunDaemonOptions {
  /** Temporal Server that the resident process uses. It must keep its runs. */
  server: ServerOptions;
  /** Version of the aitw that runs the resident process. */
  version: string;
  /** Stops the resident process when aborted, such as on SIGTERM. */
  signal: AbortSignal;
  /** Prepares the workflow engine before the Workers start. */
  prepareEngine: () => void;
}

/** Largest body of a request to the resident process, in bytes. */
const maxBodyBytes = 64 * 1024;

/** Reads the JSON body of a request. */
const readJson = async (incoming: IncomingMessage): Promise<unknown> => {
  let body = "";
  incoming.setEncoding("utf8");
  for await (const chunk of incoming) {
    body += String(chunk);
    if (body.length > maxBodyBytes) {
      throw new Error("The request is too large");
    }
  }
  return JSON.parse(body);
};

const respond = (response: ServerResponse, code: number, body: unknown): void => {
  response.writeHead(code, { "content-type": "application/json" });
  response.end(body === undefined ? "" : JSON.stringify(body));
};

/** Returns whether a process runs a Temporal development server, by its command line. */
const isDevServer = (pid: number): boolean => {
  try {
    const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    return command.includes("server start-dev");
  } catch {
    // ps fails when no process has the ID.
    return false;
  }
};

/**
 * Stops the development server that a killed resident process left, if it still runs.
 *
 * The command line is checked, so that a process that reused the ID is not stopped.
 */
const stopLeftoverDevServer = async (file: string, context: CommandContext): Promise<void> => {
  let pid: number;
  try {
    pid = Number(readFileSync(file, "utf8").trim());
  } catch {
    return;
  }
  if (Number.isInteger(pid) && pid > 0 && isDevServer(pid)) {
    log(context, `aitw daemon: stopping the development server that was left running (pid ${pid})`);
    try {
      process.kill(-pid, "SIGTERM");
      for (let attempt = 0; attempt < 50 && isDevServer(pid); attempt += 1) {
        await sleep(100);
      }
      if (isDevServer(pid)) {
        process.kill(-pid, "SIGKILL");
      }
    } catch {
      // The server stopped in the meantime.
    }
  }
  rmSync(file, { force: true });
};

const log = (context: CommandContext, message: string): void => {
  context.stderr(`${new Date().toISOString()} ${message}\n`);
};

/**
 * Runs the resident process of this host in the foreground until it is stopped.
 *
 * `aitw daemon start` runs it in the background, with its output in the log file.
 *
 * @returns The exit code of the command.
 */
export const runDaemon = async (
  { prepareEngine, server, signal, version }: RunDaemonOptions,
  context: CommandContext,
): Promise<number> => {
  const paths = daemonPaths();
  checkSocketPath(paths.socket);
  mkdirSync(paths.directory, { mode: 0o700, recursive: true });

  let lock;
  try {
    lock = acquireRunLock(paths.directory, "daemon");
  } catch (error) {
    if (error instanceof RunLockedError) {
      log(context, `aitw daemon: already running (pid ${error.pid ?? "unknown"})`);
      return 1;
    }
    throw error;
  }

  let opened: OpenedServer | undefined;
  let workers: ProjectWorkers | undefined;
  const http = createServer();
  try {
    // A socket that a stopped process left behind would keep the server from listening.
    if ((await getDaemonStatus(paths)) === undefined) {
      rmSync(paths.socket, { force: true });
    }
    // A resident process that was killed could not stop its development server, which would
    // share the SQLite file with the new one.
    await stopLeftoverDevServer(paths.devServer, context);
    opened = await openServer(server, context, signal);
    if (!opened.durable) {
      throw new Error("aitw daemon needs a Temporal Server that keeps its runs");
    }
    if (opened.pid !== undefined) {
      writeFileSync(paths.devServer, `${opened.pid}\n`, { mode: 0o600 });
    }

    const stopping = new AbortController();
    signal.addEventListener("abort", () => stopping.abort(), { once: true });
    const address = opened.address;
    workers = createProjectWorkers({
      address,
      file: paths.projects,
      log: (message) => log(context, `aitw daemon: ${message}`),
      prepareEngine,
    });
    const projects = workers;
    // Projects that the resident process served before it stopped keep their runs going.
    await projects.restore();
    const startedAt = new Date().toISOString();
    const status = (): DaemonStatus => ({
      address,
      pid: process.pid,
      projects: projects.list(),
      serverOptions: opened?.options ?? "",
      startedAt,
      version,
      workflowCodeVersion,
      ...(opened?.uiUrl === undefined ? {} : { uiUrl: opened.uiUrl }),
    });
    http.on("request", (incoming: IncomingMessage, response: ServerResponse) => {
      if (incoming.method === "GET" && incoming.url === "/status") {
        respond(response, 200, status());
      } else if (incoming.method === "POST" && incoming.url === "/stop") {
        respond(response, 200, undefined);
        stopping.abort();
      } else if (incoming.method === "POST" && incoming.url === "/projects") {
        void readJson(incoming)
          .then(async (body) => {
            const root =
              typeof body === "object" && body !== null && "root" in body ? body.root : undefined;
            if (typeof root !== "string" || !isAbsolute(root)) {
              respond(response, 400, { error: "root must be an absolute path" });
              return;
            }
            respond(response, 200, await projects.add(await realpath(root)));
          })
          .catch((error: unknown) => {
            respond(response, 400, {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      } else {
        respond(response, 404, { error: "Not found" });
      }
    });
    // Only the user can connect to the socket, because its directory is 700.
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(paths.socket, () => {
        http.off("error", reject);
        resolve();
      });
    });
    log(context, `aitw daemon: started (pid ${process.pid}), server ${opened.address}`);

    if (!stopping.signal.aborted) {
      await new Promise<void>((resolve) => {
        stopping.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    log(context, "aitw daemon: stopping");
    return 0;
  } catch (error) {
    log(context, `aitw daemon: failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await new Promise<void>((resolve) => {
      http.close(() => resolve());
      http.closeAllConnections();
    });
    rmSync(paths.socket, { force: true });
    // The Workers stop after the scripts that they run finish, so that the runs can continue.
    await workers?.stopAll();
    await opened?.stop();
    rmSync(paths.devServer, { force: true });
    lock.release();
    log(context, "aitw daemon: stopped");
  }
};
