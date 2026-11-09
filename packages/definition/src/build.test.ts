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

    expect(buildIntermediate(definition).inputs).toEqual({});
  });

  it("makes every field explicit", () => {
    const definition = definitionSchema.parse({
      inputs: { level: { options: ["low"], type: "choice" } },
      start: "a",
      steps: {
        a: { next: "b", run: "./a.sh", timeout: "90s", type: "script" },
        b: { next: "end", run: "./b.sh", type: "script" },
      },
      version: definitionVersion,
    });

    expect(buildIntermediate(definition)).toEqual({
      inputs: { level: { options: ["low"], required: false, type: "choice" } },
      start: "a",
      steps: {
        a: {
          inputs: {},
          next: { step: "b", type: "step" },
          outputs: {},
          run: "./a.sh",
          timeoutMs: 90_000,
          type: "script",
        },
        b: {
          inputs: {},
          next: { type: "end" },
          outputs: {},
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
    expect(toDefinitionPath(["steps", "a", "answers", "name", "default"])).toEqual([
      "steps",
      "a",
      "with",
    ]);
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

describe("buildIntermediate env", () => {
  it("writes env values as text and keeps dotenv", () => {
    const definition = definitionSchema.parse({
      dotenv: ".env",
      env: { DEBUG: true, LEVEL: "info" },
      start: "a",
      steps: { a: { env: { PORT: 3000 }, next: "end", run: "./a.sh", type: "script" } },
      version: definitionVersion,
    });

    expect(buildIntermediate(definition)).toMatchObject({
      dotenv: ".env",
      env: { DEBUG: "true", LEVEL: "info" },
      steps: { a: { env: { PORT: "3000" } } },
    });
  });
});
