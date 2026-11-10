import { describe, expect, it } from "vitest";

import { intermediateVersion } from "./schema.ts";
import type { Intermediate, IntermediateStep } from "./schema.ts";
import { validateIntermediate } from "./validate.ts";

const step = (next: string | null): IntermediateStep => ({
  inputs: {},
  next: next === null ? { type: "end" } : { step: next, type: "step" },
  outputs: {},
  run: "./run.sh",
  timeoutMs: 1000,
  type: "script",
});

const intermediate = (start: string, steps: Record<string, string | null>): Intermediate => ({
  start,
  steps: Object.fromEntries(Object.entries(steps).map(([id, next]) => [id, step(next)])),
  version: intermediateVersion,
  inputs: {},
});

const errorsOf = (input: unknown) => {
  const result = validateIntermediate(input);
  return result.ok ? [] : result.errors;
};

describe("validateIntermediate", () => {
  it("accepts a single path", () => {
    expect(validateIntermediate(intermediate("a", { a: "b", b: "c", c: null }))).toMatchObject({
      ok: true,
    });
  });

  it("rejects an unknown transition type", () => {
    const input = intermediate("a", { a: null });
    expect(
      errorsOf({ ...input, steps: { a: { ...input.steps.a, next: { type: "fail" } } } }),
    ).toMatchObject([{ path: ["steps", "a", "next", "type"] }]);
  });

  it("rejects an invalid shape", () => {
    expect(errorsOf({ ...intermediate("a", { a: null }), version: 2 })).toMatchObject([
      { path: ["version"] },
    ]);
  });

  it("rejects an unknown start step", () => {
    expect(errorsOf(intermediate("x", { a: null }))).toEqual([
      { message: "Unknown step: x", path: ["start"] },
      { message: "Step is not reachable from start", path: ["steps", "a"] },
    ]);
  });

  it("rejects an unknown next step", () => {
    expect(errorsOf(intermediate("a", { a: "x" }))).toEqual([
      { message: "Unknown step: x", path: ["steps", "a", "next", "step"] },
    ]);
  });

  it("rejects a transition to the start step", () => {
    expect(errorsOf(intermediate("a", { a: "b", b: "a" }))).toEqual([
      { message: "Cannot transition to the start step: a", path: ["steps", "b", "next", "step"] },
    ]);
  });

  it("rejects a transition back to a step on its path", () => {
    expect(errorsOf(intermediate("a", { a: "b", b: "c", c: "b" }))).toEqual([
      {
        message: "Cannot transition back to step b: loops are not supported yet",
        path: ["steps", "c", "next", "step"],
      },
    ]);
  });

  it("rejects an unreachable cycle", () => {
    expect(errorsOf(intermediate("a", { a: null, b: "c", c: "b" }))).toEqual([
      { message: "Step is not reachable from start", path: ["steps", "b"] },
      { message: "Step is not reachable from start", path: ["steps", "c"] },
    ]);
  });

  it("rejects input declarations that the schema cannot check", () => {
    expect(
      errorsOf({
        ...intermediate("fetch", { fetch: null }),
        inputs: {
          level: { default: "mid", options: ["low", "low"], required: true, type: "choice" },
          threshold: { default: 1.5, required: true, type: "number" },
        },
      }),
    ).toEqual([
      { message: "Duplicate option: low", path: ["inputs", "level", "options"] },
      { message: "A required input cannot have a default", path: ["inputs", "level", "default"] },
      { message: "Must be one of low, low", path: ["inputs", "level", "default"] },
      {
        message: "A required input cannot have a default",
        path: ["inputs", "threshold", "default"],
      },
    ]);
  });
});
