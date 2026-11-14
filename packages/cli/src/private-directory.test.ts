import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensurePrivateDirectory, UnsafeDirectoryError } from "./private-directory.ts";
import { stateDirectory } from "./state.ts";

describe("ensurePrivateDirectory", () => {
  let base: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "ugoke-private-")));
  });

  afterEach(() => {
    rmSync(base, { force: true, recursive: true });
  });

  it("creates a directory that only the user can use", () => {
    const directory = ensurePrivateDirectory(join(base, "a", "ugoke"), "state directory");

    expect(directory).toBe(join(base, "a", "ugoke"));
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    // An existing directory is used as it is.
    expect(ensurePrivateDirectory(directory, "state directory")).toBe(directory);
  });

  it("returns the real path when the parent is a symbolic link", () => {
    mkdirSync(join(base, "real"), { mode: 0o700 });
    symlinkSync(join(base, "real"), join(base, "link"));

    expect(ensurePrivateDirectory(join(base, "link", "ugoke"), "state directory")).toBe(
      join(base, "real", "ugoke"),
    );
  });

  it("rejects a directory that other users can use", () => {
    mkdirSync(join(base, "ugoke"));
    chmodSync(join(base, "ugoke"), 0o755);

    expect(() => ensurePrivateDirectory(join(base, "ugoke"), "state directory")).toThrow(
      new UnsafeDirectoryError(
        `Other users can use the state directory ${join(base, "ugoke")}. Run "chmod 700 ${join(base, "ugoke")}" to fix it`,
      ),
    );
  });

  it("rejects a symbolic link", () => {
    mkdirSync(join(base, "target"), { mode: 0o700 });
    symlinkSync(join(base, "target"), join(base, "ugoke"));

    expect(() => ensurePrivateDirectory(join(base, "ugoke"), "state directory")).toThrow(
      new UnsafeDirectoryError(
        `The state directory ${join(base, "ugoke")} must be a directory, not a symbolic link or a file`,
      ),
    );
  });

  it("rejects an ancestor that other users can write to", () => {
    mkdirSync(join(base, "shared"));
    chmodSync(join(base, "shared"), 0o777);

    expect(() => ensurePrivateDirectory(join(base, "shared", "ugoke"), "cache directory")).toThrow(
      new UnsafeDirectoryError(
        `The cache directory ${join(base, "shared", "ugoke")} is unsafe, because other users can replace ${join(base, "shared")}`,
      ),
    );
  });

  it("accepts a sticky ancestor such as /tmp", () => {
    mkdirSync(join(base, "tmp"));
    chmodSync(join(base, "tmp"), 0o1777);

    expect(ensurePrivateDirectory(join(base, "tmp", "ugoke"), "state directory")).toBe(
      join(base, "tmp", "ugoke"),
    );
  });
});

describe("stateDirectory", () => {
  let base: string;
  let previous: string | undefined;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "ugoke-state-")));
    previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = base;
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previous;
    }
    rmSync(base, { force: true, recursive: true });
  });

  it("is a private directory named ugoke in XDG_STATE_HOME", () => {
    expect(stateDirectory()).toBe(join(base, "ugoke"));
    expect(statSync(join(base, "ugoke")).mode & 0o777).toBe(0o700);
  });
});
