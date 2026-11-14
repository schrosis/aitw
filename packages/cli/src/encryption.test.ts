import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EncryptionKeyError, loadEncryptionKey } from "./encryption.ts";

describe("loadEncryptionKey", () => {
  let base: string;
  let previous: string | undefined;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "ugoke-key-")));
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

  it("creates a key that only the user can read, and leaves nothing else", () => {
    const key = loadEncryptionKey();

    expect(key).toHaveLength(32);
    expect(statSync(join(base, "ugoke", "encryption.key")).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(base, "ugoke"))).toEqual(["encryption.key"]);
  });

  it("returns the same key afterwards", () => {
    expect(loadEncryptionKey()).toEqual(loadEncryptionKey());
  });

  it("does not replace a key that is invalid", () => {
    mkdirSync(join(base, "ugoke"), { mode: 0o700 });
    writeFileSync(join(base, "ugoke", "encryption.key"), "broken\n");

    expect(() => loadEncryptionKey()).toThrow(EncryptionKeyError);
  });
});
