import { resolve } from "node:path";

import type { CommandContext } from "./commands/load.js";
import { ensureTemporalCli, startDevServer } from "./temporal-cli/index.js";

/** Default address of the Temporal Server. */
export const defaultAddress = "localhost:7233";

/** Temporal Server that a command uses. */
export type ServerOptions =
  | { type: "address"; address: string }
  | {
      type: "dev";
      /** SQLite file that keeps the server state, relative to the current directory. */
      dbFilename?: string | undefined;
      /**
       * Temporal CLI to start the server with, as a path or a name in PATH. The pinned release is
       * used when it is omitted.
       */
      temporalBin?: string | undefined;
      /** Whether to start the Web UI of the server. */
      ui?: boolean | undefined;
    };

/** A Temporal Server that a command connected to or started. */
export interface OpenedServer {
  address: string;
  /**
   * Whether runs outlive the command, so that they can be resumed. A development server without
   * a SQLite file loses its runs when it stops.
   */
  durable: boolean;
  /** Options that reach the same server again, such as ` --dev --dev-db state.db`. */
  options: string;
  /** Stops the server when the command started it. */
  stop: () => Promise<void>;
  /** Process ID of the development server that the command started, if any. */
  pid?: number;
  /** URL of the Web UI of the development server, when it was started. */
  uiUrl?: string | undefined;
}

/**
 * Returns the command line options that reach a server, such as `--dev --dev-db state.db`.
 *
 * The resident process reports its options, and a command compares them with its own, so both
 * are built here to keep the same order.
 */
export const serverArguments = (server: ServerOptions): string[] =>
  server.type === "address"
    ? ["--address", server.address]
    : [
        "--dev",
        ...(server.dbFilename === undefined ? [] : ["--dev-db", server.dbFilename]),
        ...(server.temporalBin === undefined ? [] : ["--temporal-bin", server.temporalBin]),
        ...(server.ui === true ? ["--dev-ui"] : []),
      ];

/** Resolves an executable like a shell: a name without a slash is looked up in PATH. */
const resolveExecutable = (cwd: string, executable: string): string =>
  executable.includes("/") ? resolve(cwd, executable) : executable;

/** Quotes a value for a shell command line when it needs quotes. */
export const quote = (value: string): string =>
  /^[\w./:@-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Connects to a Temporal Server, or starts a development server.
 *
 * @throws When the development server cannot start, or when the signal is aborted first.
 */
export const openServer = async (
  server: ServerOptions,
  context: CommandContext,
  signal: AbortSignal,
): Promise<OpenedServer> => {
  if (server.type === "address") {
    return {
      address: server.address,
      durable: true,
      options:
        server.address === defaultAddress ? "" : ` ${serverArguments(server).map(quote).join(" ")}`,
      stop: async () => {},
    };
  }

  const executable =
    server.temporalBin === undefined
      ? await ensureTemporalCli({
          onDownload: (version) => context.stderr(`Downloading Temporal CLI ${version}\n`),
          signal,
        })
      : resolveExecutable(context.cwd, server.temporalBin);
  const devServer = await startDevServer({
    dbFilename:
      server.dbFilename === undefined ? undefined : resolve(context.cwd, server.dbFilename),
    executable,
    signal,
    ui: server.ui,
  });
  if (devServer.uiUrl !== undefined) {
    context.stderr(`Temporal Web UI: ${devServer.uiUrl}\n`);
  }
  return {
    address: devServer.address,
    durable: server.dbFilename !== undefined,
    options: ` ${serverArguments(server).map(quote).join(" ")}`,
    pid: devServer.pid,
    stop: devServer.stop,
    ...(devServer.uiUrl === undefined ? {} : { uiUrl: devServer.uiUrl }),
  };
};
