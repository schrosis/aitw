import { describe, expect, it } from "vitest";

import { alwaysEarlierSteps } from "./order.ts";
import { intermediateVersion } from "./schema.ts";
import type { Intermediate, Transition } from "./schema.ts";

const toStep = (step: string): Transition => ({ step, type: "step" });
const end: Transition = { type: "end" };

const branch = (...targets: string[]): Transition => ({
  branches: targets.map((to, index) => ({
    ...(index < targets.length - 1 ? { if: "${{ true }}" } : {}),
    to: to === "end" ? { type: "end" } : { step: to, type: "step" },
  })),
  type: "branch",
});

const workflow = (start: string, transitions: Record<string, Transition>): Intermediate => ({
  inputs: {},
  start,
  steps: Object.fromEntries(
    Object.entries(transitions).map(([id, next]) => [
      id,
      { inputs: {}, next, outputs: {}, run: "./run.sh", timeoutMs: 1000, type: "script" },
    ]),
  ),
  version: intermediateVersion,
});

/** Returns the result with sorted arrays, so that the order of the sets does not matter. */
const alwaysEarlierOf = (intermediate: Intermediate): Record<string, string[]> =>
  Object.fromEntries(
    [...alwaysEarlierSteps(intermediate)].map(([id, steps]) => [id, [...steps].toSorted()]),
  );

describe("alwaysEarlierSteps", () => {
  it("returns every earlier step of a single path", () => {
    expect(alwaysEarlierOf(workflow("a", { a: toStep("b"), b: toStep("c"), c: end }))).toEqual({
      a: [],
      b: ["a"],
      c: ["a", "b"],
    });
  });

  it("returns only the steps before a branch for the steps after it joins", () => {
    expect(
      alwaysEarlierOf(
        workflow("a", { a: branch("b", "c"), b: toStep("d"), c: toStep("d"), d: end }),
      ),
    ).toEqual({ a: [], b: ["a"], c: ["a"], d: ["a"] });
  });

  it("does not return a step that a branch can skip", () => {
    expect(alwaysEarlierOf(workflow("a", { a: branch("b", "c"), b: toStep("c"), c: end }))).toEqual(
      { a: [], b: ["a"], c: ["a"] },
    );
  });

  it("returns the steps of a loop that always run before a step", () => {
    expect(
      alwaysEarlierOf(
        workflow("a", { a: toStep("b"), b: toStep("c"), c: branch("b", "d"), d: end }),
      ),
    ).toEqual({ a: [], b: ["a"], c: ["a", "b"], d: ["a", "b", "c"] });
  });

  it("does not return a step itself when it loops to itself", () => {
    expect(alwaysEarlierOf(workflow("a", { a: toStep("b"), b: branch("b", "c"), c: end }))).toEqual(
      { a: [], b: ["a"], c: ["a", "b"] },
    );
  });

  it("returns nothing for start when a loop goes back to it", () => {
    expect(alwaysEarlierOf(workflow("a", { a: toStep("b"), b: branch("a", "c"), c: end }))).toEqual(
      { a: [], b: ["a"], c: ["a", "b"] },
    );
  });

  it("skips unknown and unreachable steps", () => {
    expect(
      alwaysEarlierOf(workflow("a", { a: branch("x", "b"), b: end, unused: toStep("b") })),
    ).toEqual({ a: [], b: ["a"] });
  });

  it("returns nothing when start is unknown", () => {
    expect(alwaysEarlierOf(workflow("x", { a: end }))).toEqual({});
  });
});
