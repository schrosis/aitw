import { mkdirSync, rmSync } from "node:fs";
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

/** Options of {@link runDaemon}. */
export interface RunDaemonOptions {
  /** Temporal Server that the resident process uses. It must keep its runs. */
  server: ServerOptions;
  /** Version of the aitw that runs the resident process. */
  version: string;
  /** Stops the resident process when aborted, such as on SIGTERM. */
  signal: AbortSignal;
}

const respond = (response: ServerResponse, code: number, body: unknown): void => {
  response.writeHead(code, { "content-type": "application/json" });
  response.end(body === undefined ? "" : JSON.stringify(body));
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
  { server, signal, version }: RunDaemonOptions,
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
  const http = createServer();
  try {
    // A socket that a stopped process left behind would keep the server from listening.
    if ((await getDaemonStatus(paths)) === undefined) {
      rmSync(paths.socket, { force: true });
    }
    opened = await openServer(server, context, signal);
    if (!opened.durable) {
      throw new Error("aitw daemon needs a Temporal Server that keeps its runs");
    }

    const stopping = new AbortController();
    signal.addEventListener("abort", () => stopping.abort(), { once: true });
    const status: DaemonStatus = {
      address: opened.address,
      pid: process.pid,
      serverOptions: opened.options,
      startedAt: new Date().toISOString(),
      version,
      workflowCodeVersion,
    };
    http.on("request", (incoming: IncomingMessage, response: ServerResponse) => {
      if (incoming.method === "GET" && incoming.url === "/status") {
        respond(response, 200, status);
      } else if (incoming.method === "POST" && incoming.url === "/stop") {
        respond(response, 200, undefined);
        stopping.abort();
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
    await opened?.stop();
    lock.release();
    log(context, "aitw daemon: stopped");
  }
};
