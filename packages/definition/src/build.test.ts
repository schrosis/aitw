import { describe, expect, it } from "vitest";

import { buildIntermediate, toDefinitionPath } from "./build.ts";
import { definitionSchema, definitionVersion } from "./schema.ts";

describe("buildIntermediate", () => {
  it("defaults the workflow input to no declarations", () => {
    const definition = definitionSchema.parse({
      start: "a",
      steps: { a: { next: "end", run: "./a.sh", type: "script" } },
      version: definitionVersion,
    });

    expect(buildIntermediate(definition).input).toEqual({});
  });

  it("makes every field explicit", () => {
    const definition = definitionSchema.parse({
      input: { level: { options: ["low"], type: "choice" } },
      start: "a",
      steps: {
        a: { next: "b", run: "./a.sh", timeout: "90s", type: "script" },
        b: { next: "end", run: "./b.sh", type: "script" },
      },
      version: definitionVersion,
    });

    expect(buildIntermediate(definition)).toEqual({
      input: { level: { options: ["low"], required: false, type: "choice" } },
      start: "a",
      steps: {
        a: {
          input: {},
          next: { step: "b", type: "step" },
          output: {},
          run: "./a.sh",
          timeoutMs: 90_000,
          type: "script",
        },
        b: {
          input: {},
          next: { type: "end" },
          output: {},
          run: "./b.sh",
          timeoutMs: 1_800_000,
          type: "script",
        },
      },
      version: 1,
    });
  });
});

describe("toDefinitionPath", () => {
  it("maps renamed fields", () => {
    expect(toDefinitionPath(["steps", "a", "timeoutMs"])).toEqual(["steps", "a", "timeout"]);
    expect(toDefinitionPath(["steps", "a", "next", "step"])).toEqual(["steps", "a", "next"]);
  });

  it("keeps step IDs that match field names", () => {
    expect(toDefinitionPath(["steps", "timeoutMs"])).toEqual(["steps", "timeoutMs"]);
    expect(toDefinitionPath(["steps", "timeoutMs", "next", "step"])).toEqual([
      "steps",
      "timeoutMs",
      "next",
    ]);
  });
});
