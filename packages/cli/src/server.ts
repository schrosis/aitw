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
}

/** Resolves an executable like a shell: a name without a slash is looked up in PATH. */
const resolveExecutable = (cwd: string, executable: string): string =>
  executable.includes("/") ? resolve(cwd, executable) : executable;

/** Quotes a value for a shell command line when it needs quotes. */
const quote = (value: string): string =>
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
      options: server.address === defaultAddress ? "" : ` --address ${quote(server.address)}`,
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
  });
  context.stderr(`Temporal Web UI: ${devServer.uiUrl}\n`);
  const options = [
    " --dev",
    ...(server.dbFilename === undefined ? [] : [` --dev-db ${quote(server.dbFilename)}`]),
    ...(server.temporalBin === undefined ? [] : [` --temporal-bin ${quote(server.temporalBin)}`]),
  ].join("");
  return {
    address: devServer.address,
    durable: server.dbFilename !== undefined,
    options,
    pid: devServer.pid,
    stop: devServer.stop,
  };
};
