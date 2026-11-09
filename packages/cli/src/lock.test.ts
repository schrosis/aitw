import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireRunLock, RunLockedError } from "./lock.ts";

describe("acquireRunLock", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "aitw-lock-"));
  });

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  it("keeps a second process from taking the lock until it is released", () => {
    const lock = acquireRunLock(directory, "release/notes-1");

    expect(() => acquireRunLock(directory, "release/notes-1")).toThrow(RunLockedError);
    lock.release();
    acquireRunLock(directory, "release/notes-1").release();
  });

  it("takes over a lock that a stopped process left", () => {
    // Process IDs are positive and far below this value on the platforms that aitw supports.
    writeFileSync(join(directory, "run.lock"), "2147483646\n");

    expect(() => acquireRunLock(directory, "run").release()).not.toThrow();
  });
});
