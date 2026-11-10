import { describe, expect, it } from "vitest";

import { intermediateVersion } from "./schema.ts";
import type { AiStep, Intermediate } from "./schema.ts";
import { validateIntermediate } from "./validate.ts";

const review = (fields: Partial<AiStep> = {}): AiStep => ({
  inputs: { diff: "${{ steps.fetch.outputs.diff }}" },
  next: { type: "end" },
  outputs: {},
  prompt: "Review ${{ inputs.diff }} for ${{ workflow.inputs.topic }}",
  provider: "claude-code",
  session: "reuse",
  timeoutMs: 1000,
  type: "ai",
  with: {},
  ...fields,
});

const workflow = (step: AiStep): Intermediate => ({
  inputs: { topic: { required: false, type: "string" } },
  start: "fetch",
  steps: {
    fetch: {
      inputs: {},
      next: { step: "review", type: "step" },
      outputs: { diff: "${{ result.stdout }}" },
      run: "./fetch.sh",
      timeoutMs: 1000,
      type: "script",
    },
    review: step,
  },
  version: intermediateVersion,
});

const errorsOf = (step: AiStep) => {
  const result = validateIntermediate(workflow(step));
  return result.ok ? [] : result.errors;
};

const schema = {
  properties: {
    author: { properties: { name: { type: "string" } }, type: "object" },
    verdict: { enum: ["approve", "changes"] },
  },
  required: ["verdict"],
  type: "object",
};

describe("validateIntermediate for AI steps", () => {
  it("accepts references in the prompt, with, and env", () => {
    expect(
      errorsOf(
        review({
          env: { TOPIC: "${{ workflow.inputs.topic }}" },
          with: { tools: ["${{ inputs.diff }}"] },
        }),
      ),
    ).toEqual([]);
  });

  it("rejects a reference to the result outside of outputs", () => {
    expect(errorsOf(review({ prompt: "${{ result.data }}" }))).toMatchObject([
      { path: ["steps", "review", "prompt"] },
    ]);
  });

  it("reads the result as text without a schema", () => {
    expect(errorsOf(review({ outputs: { text: "${{ result.data }}" } }))).toEqual([]);
    expect(errorsOf(review({ outputs: { verdict: "${{ result.data.verdict }}" } }))).toEqual([
      {
        message: "Step review has no schema, so result.data is text: ${{ result.data.verdict }}",
        path: ["steps", "review", "outputs", "verdict"],
      },
    ]);
  });

  it("allows only data in the result", () => {
    expect(errorsOf(review({ outputs: { cost: "${{ result.cost }}" } }))).toMatchObject([
      {
        message: expect.stringContaining("result.data") as unknown,
        path: ["steps", "review", "outputs", "cost"],
      },
    ]);
  });

  it("follows the properties of the schema", () => {
    expect(
      errorsOf(
        review({
          outputs: {
            data: "${{ result.data }}",
            name: "${{ result.data.author.name }}",
            verdict: "${{ result.data.verdict }}",
          },
          schema,
        }),
      ),
    ).toEqual([]);
    expect(
      errorsOf(review({ outputs: { summary: "${{ result.data.summary }}" }, schema })),
    ).toEqual([
      {
        message:
          "The schema of step review does not declare the property summary: ${{ result.data.summary }}",
        path: ["steps", "review", "outputs", "summary"],
      },
    ]);
  });

  it.each([
    ["allOf", [{ properties: { summary: { type: "string" } } }]],
    ["anyOf", [{ properties: { summary: { type: "string" } } }]],
    ["oneOf", [{ properties: { summary: { type: "string" } } }]],
    ["$ref", "#/$defs/review"],
    ["patternProperties", { "^s": { type: "string" } }],
  ])("allows a property that %s can declare beside properties", (keyword, value) => {
    const composed = { ...schema, [keyword]: value };

    expect(
      errorsOf(review({ outputs: { summary: "${{ result.data.summary }}" }, schema: composed })),
    ).toEqual([]);
  });

  it("allows what only the run can tell", () => {
    const open = { additionalProperties: true, properties: {}, type: "object" };
    const untyped = { oneOf: [{ type: "object" }] };

    expect(errorsOf(review({ outputs: { a: "${{ result.data.any }}" }, schema: open }))).toEqual(
      [],
    );
    expect(errorsOf(review({ outputs: { a: "${{ result.data.any }}" }, schema: untyped }))).toEqual(
      [],
    );
  });
});
