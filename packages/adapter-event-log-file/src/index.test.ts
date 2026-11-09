import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkflowEvent } from "@aitw/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFileEventLog, eventsFileName } from "./index.ts";

const started: WorkflowEvent = { run: "./build.sh", step: "build", type: "stepStarted" };
const output: WorkflowEvent = { step: "build", stream: "stdout", text: "ok\n", type: "stepOutput" };
const finished: WorkflowEvent = {
  durationMs: 10,
  outcome: "succeeded",
  step: "build",
  type: "stepFinished",
};

describe("createFileEventLog", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aitw-event-log-"));
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  it("reads appended events in order and continues from the cursor", async () => {
    const directory = join(root, "logs");
    const log = createFileEventLog({ directory });
    log.append("release/notes-1", started);
    log.append("release/notes-1", output);

    const first = await log.read("release/notes-1");
    expect(first.events).toEqual([started, output]);

    // Another process reads the same file through its own log.
    createFileEventLog({ directory }).append("release/notes-1", finished);
    await expect(log.read("release/notes-1", first.cursor)).resolves.toMatchObject({
      events: [finished],
    });
  });

  it("keeps each run in its own file that only the user can read", () => {
    const directory = join(root, "logs");
    createFileEventLog({ directory }).append("release/notes-1", started);

    const runDirectory = join(directory, "release%2Fnotes-1");
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(runDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(join(runDirectory, eventsFileName)).mode & 0o777).toBe(0o600);
  });

  it("returns no events for a run that has none", async () => {
    await expect(createFileEventLog({ directory: root }).read("missing")).resolves.toEqual({
      cursor: "0",
      events: [],
    });
  });

  it("reads a line that is still being written next time", async () => {
    const log = createFileEventLog({ directory: root });
    log.append("run", started);
    const file = join(root, "run", eventsFileName);
    const partial = JSON.stringify(output);
    appendFileSync(file, partial.slice(0, 10));

    const first = await log.read("run");
    expect(first.events).toEqual([started]);

    appendFileSync(file, `${partial.slice(10)}\n`);
    await expect(log.read("run", first.cursor)).resolves.toMatchObject({ events: [output] });
  });

  it("skips lines that are not events", async () => {
    mkdirSync(join(root, "run"));
    writeFileSync(
      join(root, "run", eventsFileName),
      `not json\n${JSON.stringify({ type: "unknown" })}\n${JSON.stringify(finished)}\n`,
    );

    await expect(createFileEventLog({ directory: root }).read("run")).resolves.toMatchObject({
      events: [finished],
    });
  });

  it("does not follow a symbolic link to the events file", () => {
    mkdirSync(join(root, "run"));
    writeFileSync(join(root, "target"), "");
    symlinkSync(join(root, "target"), join(root, "run", eventsFileName));

    expect(() => createFileEventLog({ directory: root }).append("run", started)).toThrow();
  });

  it("does not write into a symbolic link to a directory", () => {
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), join(root, "run"));

    expect(() => createFileEventLog({ directory: root }).append("run", started)).toThrow(
      "Expected a directory for the event log",
    );
  });
});
