import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { join } from "node:path";

import { workflowCodeVersion } from "@aitw/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOutput } from "../testing.ts";
import { connectDaemon, DaemonUnavailableError } from "./connect.ts";
import { daemonPaths } from "./paths.ts";

describe("connectDaemon", () => {
  let state: string;
  let previous: string | undefined;
  let server: Server | undefined;
  const requests: { method: string | undefined; url: string | undefined; body: string }[] = [];

  beforeEach(() => {
    // A short directory keeps the socket path within the limit of the platform.
    state = mkdtempSync("/tmp/aitw-connect-");
    previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = state;
    requests.length = 0;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server === undefined) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    server = undefined;
    if (previous === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previous;
    }
    rmSync(state, { force: true, recursive: true });
  });

  /** Serves a fake resident process that reports a version. */
  const serve = async (version: string): Promise<void> => {
    const paths = daemonPaths();
    mkdirSync(paths.directory, { recursive: true });
    server = createServer((incoming, response) => {
      let body = "";
      incoming.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      incoming.on("end", () => {
        requests.push({ body, method: incoming.method, url: incoming.url });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            incoming.url === "/status"
              ? {
                  address: "127.0.0.1:7233",
                  pid: 1,
                  projects: [],
                  serverOptions: "",
                  startedAt: "",
                  version,
                  workflowCodeVersion,
                }
              : { root: "/project", taskQueue: "aitw-host-hash" },
          ),
        );
      });
    });
    const listening = server;
    await new Promise<void>((resolve) => listening.listen(paths.socket, resolve));
  };

  it("registers the project with a resident process of the same version", async () => {
    await serve("1.2.3");
    const output = createOutput();

    await expect(
      connectDaemon("/project", "1.2.3", { cwd: "/", ...output }),
    ).resolves.toMatchObject({
      project: { root: "/project", taskQueue: "aitw-host-hash" },
      server: { address: "127.0.0.1:7233", durable: true },
    });
    expect(requests).toEqual([
      { body: "", method: "GET", url: "/status" },
      { body: JSON.stringify({ root: "/project" }), method: "POST", url: "/projects" },
    ]);
  });

  it("runs its own Worker on its server when the resident process has another version", async () => {
    await serve("0.9.0");
    const output = createOutput();

    await expect(connectDaemon("/project", "1.2.3", { cwd: "/", ...output })).resolves.toEqual({
      server: expect.objectContaining({ address: "127.0.0.1:7233", durable: true }) as unknown,
    });
    expect(output.written.stderr).toBe(
      'aitw daemon: runs aitw 0.9.0, and this is aitw 1.2.3, so this command runs its own Worker. Run "aitw daemon stop" and start it again to use it\n',
    );
    expect(requests.map(({ url }) => url)).toEqual(["/status"]);
  });

  it("tells how to choose a server when no resident process runs", async () => {
    const output = createOutput();

    await expect(
      connectDaemon(join(state, "project"), "1.2.3", { cwd: "/", ...output }),
    ).rejects.toThrow(new DaemonUnavailableError("is not running"));
    expect(output.written).toEqual({ stderr: "", stdout: "" });
  });
});
