import { request } from "node:http";

import type { DaemonPaths } from "./paths.js";

/** State of the resident process that `GET /status` returns. */
export interface DaemonStatus {
  pid: number;
  /** Address of the Temporal Server that the resident process uses. */
  address: string;
  /** Options that reach the same Temporal Server again, such as ` --dev --dev-db state.db`. */
  serverOptions: string;
  /** Version of the aitw that runs the resident process. */
  version: string;
  /** Workflow code version of the resident process. */
  workflowCodeVersion: number;
  startedAt: string;
}

/** Sends a request to the resident process and returns its JSON response. */
const call = async (paths: DaemonPaths, method: "GET" | "POST", path: string): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const outgoing = request({ method, path, socketPath: paths.socket }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`aitw daemon answered ${response.statusCode ?? "nothing"}: ${body}`));
          return;
        }
        try {
          resolve(body === "" ? undefined : JSON.parse(body));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    outgoing.on("error", reject);
    outgoing.end();
  });

const isStatus = (value: unknown): value is DaemonStatus =>
  typeof value === "object" &&
  value !== null &&
  "pid" in value &&
  typeof value.pid === "number" &&
  "address" in value &&
  typeof value.address === "string";

/**
 * Returns the state of the resident process, or `undefined` when it does not run.
 *
 * A socket that no process listens on, such as one that a killed process left, counts as not
 * running.
 */
export const getDaemonStatus = async (paths: DaemonPaths): Promise<DaemonStatus | undefined> => {
  try {
    const status = await call(paths, "GET", "/status");
    if (!isStatus(status)) {
      throw new Error("aitw daemon answered an unexpected status");
    }
    return status;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT" || code === "ECONNREFUSED") {
      return undefined;
    }
    throw error;
  }
};

/** Asks the resident process to stop. It answers before it stops. */
export const requestDaemonStop = async (paths: DaemonPaths): Promise<void> => {
  await call(paths, "POST", "/stop");
};
