import { describe, expect, it } from "vitest";

import { createDefinitionJsonSchema, definitionSchema } from "./schema.ts";

const validDefinition = {
  version: 1,
  start: "fetch",
  steps: {
    fetch: {
      type: "script",
      run: "./fetch.sh",
      timeout: "5m",
      output: { title: "${{ result.stdout }}" },
      next: "report",
    },
    report: {
      type: "script",
      run: './report.sh "${{ input.title }}"',
      input: { title: "${{ steps.fetch.output.title }}" },
      next: "end",
    },
  },
};

function withFetchStep(step: Record<string, unknown>): unknown {
  return {
    ...validDefinition,
    steps: {
      ...validDefinition.steps,
      fetch: { ...validDefinition.steps.fetch, ...step },
    },
  };
}

describe("definitionSchema", () => {
  it("accepts a valid definition", () => {
    expect(definitionSchema.parse(validDefinition)).toEqual(validDefinition);
  });

  it("accepts end as a transition target", () => {
    expect(definitionSchema.safeParse(withFetchStep({ next: "end" })).success).toBe(true);
  });

  it.each([
    ["an unsupported version", { ...validDefinition, version: 2 }],
    ["a missing start", { version: 1, steps: validDefinition.steps }],
    ["end as the start", { ...validDefinition, start: "end" }],
    ["an unknown root field", { ...validDefinition, name: "daily-report" }],
    ["end as a step ID", { ...validDefinition, steps: { end: validDefinition.steps.report } }],
    [
      "a hyphen in a step ID",
      { ...validDefinition, steps: { "my-step": validDefinition.steps.report } },
    ],
    [
      "a digit at the start of a step ID",
      { ...validDefinition, steps: { "1step": validDefinition.steps.report } },
    ],
    ["a missing step type", withFetchStep({ type: undefined })],
    ["an unsupported step type", withFetchStep({ type: "ai" })],
    ["an empty run command", withFetchStep({ run: "" })],
    ["a missing next", withFetchStep({ next: undefined })],
    ["a hyphen in next", withFetchStep({ next: "my-step" })],
    ["an unknown step field", withFetchStep({ retry: 3 })],
    ["a timeout without a unit", withFetchStep({ timeout: "5" })],
    ["a zero timeout", withFetchStep({ timeout: "0s" })],
    ["a numeric timeout", withFetchStep({ timeout: 5 })],
    ["a hyphen in an output name", withFetchStep({ output: { "my-title": "x" } })],
    ["a hyphen in an input name", withFetchStep({ input: { "my-title": "x" } })],
    ["an empty input expression", withFetchStep({ input: { title: "" } })],
  ])("rejects %s", (_name, definition) => {
    expect(definitionSchema.safeParse(definition).success).toBe(false);
  });
});

describe("createDefinitionJsonSchema", () => {
  it("describes the required root fields", () => {
    expect(createDefinitionJsonSchema()).toMatchObject({
      additionalProperties: false,
      required: ["version", "start", "steps"],
      type: "object",
    });
  });
});
