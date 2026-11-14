import { describe, expect, it } from "vitest";

import { builtinHelpers, describeType, trim } from "./helpers.ts";

describe("trim", () => {
  it.each([
    ["  hello\n\n", "hello"],
    ["a b\n c", "a b\n c"],
    ["\r\n\t", ""],
    [" x　", "x"],
    ["﻿x", "x"],
  ])("trims %j", (value, trimmed) => {
    expect(trim.call([value])).toEqual({ ok: true, value: trimmed });
  });

  it.each([
    [null, "null"],
    [3, "number"],
    [true, "boolean"],
    [{ a: "b" }, "object"],
    [["a"], "array"],
  ])("fails on %j", (value, type) => {
    expect(trim.call([value])).toEqual({
      message: `trim expects a string but got ${type}`,
      ok: false,
    });
  });

  it("takes one argument", () => {
    expect(trim.arity).toEqual({ max: 1, min: 1 });
  });

  it("is a builtin helper", () => {
    expect(builtinHelpers.get("trim")).toBe(trim);
  });
});

describe("describeType", () => {
  it.each([
    [null, "null"],
    ["a", "string"],
    [1.5, "number"],
    [false, "boolean"],
    [[], "array"],
    [{}, "object"],
    [undefined, "undefined"],
  ])("describes %j as %s", (value, type) => {
    expect(describeType(value)).toBe(type);
  });
});
