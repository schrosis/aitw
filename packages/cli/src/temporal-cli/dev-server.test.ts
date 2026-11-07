import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startDevServer } from "./dev-server.ts";
import { ensureTemporalCli } from "./download.ts";

const canConnect = async (address: string): Promise<boolean> => {
  const [host = "", port = ""] = address.split(":");
  return new Promise((resolve) => {
    const socket = createConnection({ host, port: Number(port) });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
};

describe("startDevServer", () => {
  let executable: string;
  let root: string;

  beforeAll(async () => {
    // The pinned release is verified against its checksum and cached after the first run.
    executable = await ensureTemporalCli();
    root = mkdtempSync(join(tmpdir(), "aitw-dev-server-"));
  }, 120_000);

  afterAll(() => {
    rmSync(root, { force: true, recursive: true });
  });

  it("starts a server that accepts connections and stops it", async () => {
    const server = await startDevServer({ executable });

    expect(server.address).toMatch(/^127\.0\.0\.1:\d+$/u);
    expect(server.uiUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    await expect(canConnect(server.address)).resolves.toBe(true);
    const response = await fetch(server.uiUrl);
    expect(response.ok).toBe(true);

    await server.stop();
    await expect(canConnect(server.address)).resolves.toBe(false);
  }, 60_000);

  it("keeps the state in a SQLite file", async () => {
    const dbFilename = join(root, "temporal.db");
    const server = await startDevServer({ dbFilename, executable });
    await server.stop();

    expect(existsSync(dbFilename)).toBe(true);
  }, 60_000);

  it("reports a server that exits before it starts", async () => {
    const failing = join(root, "failing-temporal");
    writeFileSync(failing, "#!/bin/sh\necho 'unknown flag' >&2\nexit 3\n", { mode: 0o755 });

    await expect(startDevServer({ executable: failing })).rejects.toThrow(
      "Temporal dev server exited with code 3:\nunknown flag",
    );
  });

  it("reports a missing executable", async () => {
    await expect(startDevServer({ executable: join(root, "missing") })).rejects.toThrow(
      "Failed to start the Temporal CLI",
    );
  });
});
