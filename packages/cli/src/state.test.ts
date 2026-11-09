import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StateDirectoryError, stateDirectory } from "./state.ts";

describe("stateDirectory", () => {
  let base: string;
  let previous: string | undefined;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "aitw-state-"));
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

  it("creates a directory that only the user can use", () => {
    const directory = stateDirectory();

    expect(directory).toBe(join(base, "aitw"));
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    // An existing directory is used as it is.
    expect(stateDirectory()).toBe(directory);
  });

  it("rejects a directory that other users can use", () => {
    mkdirSync(join(base, "aitw"), { mode: 0o700 });
    chmodSync(join(base, "aitw"), 0o755);

    expect(() => stateDirectory()).toThrow(
      new StateDirectoryError(
        `Other users can use the state directory ${join(base, "aitw")}. Run "chmod 700 ${join(base, "aitw")}" to fix it`,
      ),
    );
  });

  it("rejects a symbolic link", () => {
    const target = join(base, "target");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(base, "aitw"));

    expect(() => stateDirectory()).toThrow(StateDirectoryError);
  });
});
