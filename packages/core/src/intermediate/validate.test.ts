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

  it("accepts a transition back to the start step when the workflow can finish", () => {
    const steps = {
      a: step("b"),
      b: {
        ...step(null),
        next: {
          branches: [
            { if: "${{ result.stdout == 'x' }}", to: { step: "a", type: "step" as const } },
            { to: { type: "end" as const } },
          ],
          type: "branch" as const,
        },
      },
    };

    expect(errorsOf({ ...intermediate("a", {}), steps })).toEqual([]);
  });

  it("reports every step of a loop that cannot reach the end", () => {
    expect(errorsOf(intermediate("a", { a: "b", b: "a" }))).toEqual([
      {
        message: "Step a cannot reach end, so the workflow could never finish",
        path: ["steps", "a", "next"],
      },
      {
        message: "Step b cannot reach end, so the workflow could never finish",
        path: ["steps", "b", "next"],
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
