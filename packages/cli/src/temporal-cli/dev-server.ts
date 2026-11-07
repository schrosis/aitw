import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

/** Options of {@link startDevServer}. */
export interface DevServerOptions {
  /** Path of the Temporal CLI executable. */
  executable: string;
  /** SQLite file that keeps the server state. The state is kept in memory when it is omitted. */
  dbFilename?: string | undefined;
  /** Time to wait for the server to accept connections, in milliseconds. */
  startTimeoutMs?: number;
  /** Time to wait for the server to stop after SIGTERM before it is killed, in milliseconds. */
  stopGraceMs?: number;
}

/** A running Temporal development server. */
export interface DevServer {
  /** Address of the frontend service, such as `127.0.0.1:7233`. */
  address: string;
  /** URL of the Web UI. */
  uiUrl: string;
  /** Stops the server and waits for it to exit. */
  stop: () => Promise<void>;
}

const host = "127.0.0.1";

/** Size of the server log that is kept to explain a failed start, in characters. */
const maxLogLength = 4096;

/** Returns a TCP port that is free at the moment. */
const freePort = async (): Promise<number> => {
  const server = createServer();
  server.listen(0, host);
  await once(server, "listening");
  const address = server.address();
  server.close();
  await once(server, "close");
  if (address === null || typeof address === "string") {
    throw new Error("Failed to find a free port");
  }
  return address.port;
};

const canConnect = async (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });

/**
 * Starts `temporal server start-dev` on free local ports and waits until it accepts connections.
 *
 * The server runs in its own process group, so that an interrupt in the terminal reaches only
 * aitw. aitw then cancels the workflow and stops the server itself.
 */
export const startDevServer = async ({
  dbFilename,
  executable,
  startTimeoutMs = 30_000,
  stopGraceMs = 5000,
}: DevServerOptions): Promise<DevServer> => {
  const [port, uiPort, httpPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const args = [
    "server",
    "start-dev",
    "--ip",
    host,
    "--port",
    String(port),
    "--ui-port",
    String(uiPort),
    "--http-port",
    String(httpPort),
    "--ui-disable-news-fetch",
    "--log-level",
    "error",
    ...(dbFilename === undefined ? [] : ["--db-filename", dbFilename]),
  ];
  const child = spawn(executable, args, {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });

  let log = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    log = (log + text).slice(-maxLogLength);
  });

  let exited = false;
  // A process that fails to spawn emits "error" and may not emit "exit".
  const exit = new Promise<void>((resolve) => {
    const settle = (): void => {
      exited = true;
      resolve();
    };
    child.once("exit", settle);
    child.once("error", settle);
  });
  const spawnError = new Promise<never>((_resolve, reject) => {
    child.once("error", (error) => {
      reject(new Error(`Failed to start the Temporal CLI at ${executable}: ${error.message}`));
    });
  });
  // The error is reported by the start below, so it must not become an unhandled rejection.
  spawnError.catch(() => {});

  const kill = (signal: NodeJS.Signals): void => {
    if (exited || child.pid === undefined) {
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      // macOS reports EPERM instead of ESRCH for a process group that has exited.
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "ESRCH" && code !== "EPERM") {
        throw error;
      }
    }
  };

  const stop = async (): Promise<void> => {
    kill("SIGTERM");
    const timer = setTimeout(() => kill("SIGKILL"), stopGraceMs);
    await exit;
    clearTimeout(timer);
  };

  const failure = (message: string): Error => {
    const details = log.trim();
    return new Error(details === "" ? message : `${message}:\n${details}`);
  };

  const ready = async (): Promise<void> => {
    const deadline = performance.now() + startTimeoutMs;
    while (!(await canConnect(port))) {
      if (exited) {
        throw failure(`Temporal dev server exited with code ${child.exitCode ?? "unknown"}`);
      }
      if (performance.now() > deadline) {
        throw failure(`Temporal dev server did not start within ${startTimeoutMs} ms`);
      }
      await sleep(100);
    }
  };

  try {
    await Promise.race([ready(), spawnError]);
  } catch (error) {
    await stop();
    throw error;
  }
  return { address: `${host}:${port}`, stop, uiUrl: `http://${host}:${uiPort}` };
};
