import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readDotenv, readEnvironment } from "./index.ts";

describe("readDotenv", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "ugoke-dotenv-")));
  });

  afterEach(() => {
    rmSync(cwd, { force: true, recursive: true });
  });

  it("reads a file in the working directory", () => {
    writeFileSync(join(cwd, ".env"), "NAME=value\n");

    expect(readDotenv(cwd, ".env")).toEqual({ ok: true, values: { NAME: "value" } });
  });

  it("reads a file in the root whose name starts with two dots", () => {
    writeFileSync(join(cwd, "..env"), "NAME=value\n");

    expect(readDotenv(cwd, "..env")).toMatchObject({ ok: true });
  });

  it("reports a missing file", () => {
    expect(readDotenv(cwd, "missing.env")).toMatchObject({
      message: expect.stringContaining(
        "Failed to read the dotenv file missing.env: ENOENT",
      ) as unknown,
      ok: false,
    });
  });

  it("does not read a file outside of the working directory through a link", () => {
    const outside = mkdtempSync(join(tmpdir(), "ugoke-outside-"));
    try {
      writeFileSync(join(outside, "secrets.env"), "SECRET=x\n");
      symlinkSync(join(outside, "secrets.env"), join(cwd, ".env"));

      expect(readDotenv(cwd, ".env")).toEqual({
        message: "Failed to read the dotenv file .env: it is outside of the project root",
        ok: false,
      });
    } finally {
      rmSync(outside, { force: true, recursive: true });
    }
  });
});

describe("readEnvironment", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "ugoke-environment-")));
  });

  afterEach(() => {
    rmSync(cwd, { force: true, recursive: true });
  });

  it("returns the inherited variables without a file", () => {
    expect(readEnvironment(cwd, undefined)).toEqual({ ok: true, values: process.env });
  });

  it("keeps inherited variables over the file", () => {
    writeFileSync(join(cwd, ".env"), "FROM_FILE=file\nHOME=from-file\n");

    expect(readEnvironment(cwd, ".env")).toMatchObject({
      ok: true,
      values: { FROM_FILE: "file", HOME: process.env.HOME },
    });
  });

  it("reports a file that cannot be read", () => {
    expect(readEnvironment(cwd, "missing.env")).toMatchObject({ ok: false });
  });
});
