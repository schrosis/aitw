import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { join } from "node:path";

import { workflowCodeVersion } from "@aitw/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOutput } from "../testing.ts";
import { connectDaemon, DaemonUnavailableError, openCommandServer } from "./connect.ts";
import { daemonPaths } from "./paths.ts";

/** Opens the server of a command for a project without server options. */
const open = async (root: string, output = createOutput()) =>
  openCommandServer(
    { version: "1.2.3" },
    root,
    { cwd: root, ...output },
    new AbortController().signal,
  );

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

  /**
   * Serves a fake resident process that reports a version.
   *
   * @param projectAddress Server that it reports for the projects that it serves.
   */
  const serve = async (version: string, projectAddress = "127.0.0.1:7233"): Promise<void> => {
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
              : { address: projectAddress, root: "/project", taskQueue: "aitw-host-hash" },
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
      project: { address: "127.0.0.1:7233", root: "/project", taskQueue: "aitw-host-hash" },
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

  const project = (address: string): string => {
    const root = join(state, "project");
    mkdirSync(join(root, ".aitw"), { recursive: true });
    writeFileSync(join(root, ".aitw", "config.yaml"), `temporal:\n  address: ${address}\n`);
    return root;
  };

  describe("with a project that names its Temporal Server", () => {
    it("runs its own Worker on the server without a resident process", async () => {
      await expect(open(project("temporal.example.com:7233"))).resolves.toEqual({
        server: expect.objectContaining({
          address: "temporal.example.com:7233",
          options: "",
        }) as unknown,
        servedTaskQueue: undefined,
      });
    });

    it("asks the resident process to run the steps on the server of the project", async () => {
      await serve("1.2.3", "temporal.example.com:7233");

      await expect(open(project("temporal.example.com:7233"))).resolves.toMatchObject({
        server: { address: "temporal.example.com:7233" },
        servedTaskQueue: "aitw-host-hash",
      });
      expect(requests.map(({ url }) => url)).toEqual(["/status", "/projects"]);
    });

    it("runs its own Worker when the resident process serves the project elsewhere, and says why", async () => {
      // The configuration file changed after the resident process read it.
      await serve("1.2.3", "127.0.0.1:7233");
      const output = createOutput();

      await expect(open(project("temporal.example.com:7233"), output)).resolves.toMatchObject({
        server: { address: "temporal.example.com:7233" },
        servedTaskQueue: undefined,
      });
      expect(output.written.stderr).toBe(
        "aitw daemon: serves the project at 127.0.0.1:7233, and temporal.address of the project is temporal.example.com:7233, so this command runs its own Worker\n",
      );
    });

    it("runs its own Worker when the resident process has another version, and says why", async () => {
      await serve("0.9.0");
      const output = createOutput();

      await expect(open(project("127.0.0.1:7233"), output)).resolves.toMatchObject({
        servedTaskQueue: undefined,
      });
      expect(output.written.stderr).toContain("runs aitw 0.9.0, and this is aitw 1.2.3");
    });

    it("says nothing when no resident process runs", async () => {
      const output = createOutput();

      await open(project("temporal.example.com:7233"), output);

      expect(output.written).toEqual({ stderr: "", stdout: "" });
    });

    it("prefers the options of the command", async () => {
      await expect(
        openCommandServer(
          { server: { address: "localhost:7233", type: "address" }, version: "1.2.3" },
          project("temporal.example.com:7233"),
          { cwd: "/", ...createOutput() },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ server: { address: "localhost:7233" } });
    });
  });
});
