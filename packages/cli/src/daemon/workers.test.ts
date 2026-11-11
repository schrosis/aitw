import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StartWorkerOptions } from "@aitw/engine";
import { workflowCodeVersion } from "@aitw/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { projectTaskQueue } from "../state.ts";
import { createProjectWorkers } from "./workers.ts";

const succeed = async () => ({ stop: async () => {} });

describe("createProjectWorkers", () => {
  let directory: string;
  let file: string;
  let project: string;
  let started: StartWorkerOptions[];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "aitw-workers-"));
    file = join(directory, "projects.json");
    project = join(directory, "project");
    mkdirSync(join(project, ".aitw"), { recursive: true });
    started = [];
  });

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  const create = (start: (options: StartWorkerOptions) => Promise<{ stop: () => Promise<void> }>) =>
    createProjectWorkers({
      address: "127.0.0.1:7233",
      file,
      log: () => {},
      prepareEngine: () => {},
      startWorker: async (options) => {
        started.push(options);
        return start(options);
      },
    });

  it("serves a project on its versioned task queue and keeps it in the file", async () => {
    const workers = create(succeed);

    await expect(workers.add(project)).resolves.toEqual({
      address: "127.0.0.1:7233",
      root: project,
      taskQueue: projectTaskQueue(project),
    });
    expect(projectTaskQueue(project)).toMatch(new RegExp(`-v${workflowCodeVersion}$`, "u"));
    expect(started.map(({ taskQueue }) => taskQueue)).toEqual([projectTaskQueue(project)]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([project]);

    await workers.add(project);
    expect(started).toHaveLength(1);
  });

  it("rejects a directory without .aitw", async () => {
    await expect(create(succeed).add(directory)).rejects.toThrow("has no .aitw directory");
  });

  it("keeps a project whose Worker cannot start yet, and drops one that was removed", async () => {
    const missing = join(directory, "missing");
    writeFileSync(file, JSON.stringify([project, missing]));
    const workers = create(async () => Promise.reject(new Error("server unreachable")));

    await workers.restore();

    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([project]);
    expect(workers.list()).toEqual([
      {
        address: "127.0.0.1:7233",
        root: project,
        running: false,
        taskQueue: projectTaskQueue(project),
      },
    ]);
  });

  it("starts a Worker again after it failed", async () => {
    const workers = create(async (options) => {
      // The first Worker fails after it started.
      if (started.length === 1) {
        setImmediate(() => options.onError?.(new Error("connection lost")));
      }
      return { stop: async () => {} };
    });
    await workers.add(project);
    await new Promise((resolve) => setImmediate(resolve));

    expect(workers.list()).toMatchObject([{ running: false }]);
    await workers.add(project);
    expect(started).toHaveLength(2);
    expect(workers.list()).toMatchObject([{ running: true }]);
  });

  it("runs the Worker on the server that the project names", async () => {
    writeFileSync(
      join(project, ".aitw", "config.yaml"),
      "temporal:\n  address: temporal.example.com:7233\n",
    );
    const workers = create(succeed);

    await expect(workers.add(project)).resolves.toMatchObject({
      address: "temporal.example.com:7233",
    });
    expect(started.map(({ address }) => address)).toEqual(["temporal.example.com:7233"]);
    expect(workers.list()).toMatchObject([{ address: "temporal.example.com:7233", running: true }]);
  });

  it("moves to the server that the project names now, and keeps the previous Worker until it stops", async () => {
    const stopped: string[] = [];
    const workers = create(async ({ address }) => ({
      stop: async () => {
        stopped.push(address);
      },
    }));
    await workers.add(project);

    writeFileSync(
      join(project, ".aitw", "config.yaml"),
      "temporal:\n  address: temporal.example.com:7233\n",
    );
    await workers.add(project);
    await workers.add(project);

    expect(started.map(({ address }) => address)).toEqual([
      "127.0.0.1:7233",
      "temporal.example.com:7233",
    ]);
    expect(stopped).toEqual([]);
    expect(workers.list()).toMatchObject([
      {
        address: "temporal.example.com:7233",
        previousAddresses: ["127.0.0.1:7233"],
        running: true,
      },
    ]);
    await workers.stopAll();
    expect(stopped.toSorted()).toEqual(["127.0.0.1:7233", "temporal.example.com:7233"]);
  });

  it("uses the Worker on a server again when the project names it again", async () => {
    const workers = create(succeed);
    const config = join(project, ".aitw", "config.yaml");
    await workers.add(project);
    writeFileSync(config, "temporal:\n  address: temporal.example.com:7233\n");
    await workers.add(project);
    rmSync(config);

    await expect(workers.add(project)).resolves.toMatchObject({ address: "127.0.0.1:7233" });
    expect(started.map(({ address }) => address)).toEqual([
      "127.0.0.1:7233",
      "temporal.example.com:7233",
    ]);
    expect(workers.list()).toMatchObject([
      { address: "127.0.0.1:7233", previousAddresses: ["temporal.example.com:7233"] },
    ]);
  });

  it("starts one Worker for concurrent requests of a project", async () => {
    const workers = create(succeed);

    await Promise.all([workers.add(project), workers.add(project), workers.restore()]);

    expect(started).toHaveLength(1);
  });

  it("rejects a project whose configuration file is invalid", async () => {
    writeFileSync(join(project, ".aitw", "config.yaml"), "temporal:\n  port: 7233\n");

    await expect(create(succeed).add(project)).rejects.toThrow("Unknown field: port");
    expect(started).toEqual([]);
  });
});
