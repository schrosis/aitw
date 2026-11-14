import {
  createPluginRegistry,
  defineAiProvider,
  definePlugin,
  defineWaitMethod,
} from "@ugoke/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createDefinitionJsonSchema,
  defaultStepTimeout,
  definitionSchema,
  definitionVersion,
} from "./schema.ts";

const validDefinition = {
  version: definitionVersion,
  start: "fetch",
  steps: {
    fetch: {
      type: "script",
      run: "./fetch.sh",
      timeout: "5m",
      outputs: { title: "${{ result.stdout }}" },
      next: "report",
    },
    report: {
      type: "script",
      run: './report.sh "${{ inputs.title }}"',
      inputs: { title: "${{ steps.fetch.outputs.title }}" },
      next: "end",
    },
  },
};

const withFetchStep = (step: Record<string, unknown>): unknown => {
  return {
    ...validDefinition,
    steps: {
      ...validDefinition.steps,
      fetch: { ...validDefinition.steps.fetch, ...step },
    },
  };
};

describe("definitionSchema", () => {
  it("accepts a valid definition", () => {
    expect(definitionSchema.parse(validDefinition).steps.fetch).toEqual(
      validDefinition.steps.fetch,
    );
  });

  it("applies the default timeout", () => {
    expect(definitionSchema.parse(validDefinition).steps.report).toMatchObject({
      timeout: defaultStepTimeout,
    });
  });

  it("accepts end as a transition target", () => {
    expect(definitionSchema.safeParse(withFetchStep({ next: "end" })).success).toBe(true);
  });

  it.each([
    ["an unsupported version", { ...validDefinition, version: "v0.2" }],
    ["a version without the prefix", { ...validDefinition, version: "0.1" }],
    ["a numeric version", { ...validDefinition, version: 0.1 }],
    ["a missing start", { version: definitionVersion, steps: validDefinition.steps }],
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
    ["a hyphen in an output name", withFetchStep({ outputs: { "my-title": "x" } })],
    ["a hyphen in an input name", withFetchStep({ inputs: { "my-title": "x" } })],
    ["an empty input expression", withFetchStep({ inputs: { title: "" } })],
  ])("rejects %s", (_name, definition) => {
    expect(definitionSchema.safeParse(definition).success).toBe(false);
  });
});

describe("createDefinitionJsonSchema", () => {
  it("documents the optional timeout and its default", () => {
    expect(createDefinitionJsonSchema()).toMatchObject({
      properties: {
        steps: {
          additionalProperties: {
            oneOf: [
              {
                properties: {
                  timeout: {
                    default: defaultStepTimeout,
                    description: "Maximum duration of the step",
                  },
                },
                required: ["type", "run", "next"],
              },
              { required: ["type", "method", "next"] },
              { required: ["type", "provider", "prompt", "next"] },
            ],
          },
        },
      },
    });
  });

  it("describes the required root fields", () => {
    expect(createDefinitionJsonSchema()).toMatchObject({
      additionalProperties: false,
      required: ["version", "start", "steps"],
      type: "object",
    });
  });
});

describe("createDefinitionJsonSchema with plugins", () => {
  const plugins = createPluginRegistry({
    builtins: [
      definePlugin({
        aiProviders: [
          defineAiProvider({
            name: "echo",
            run: async () => ({ data: "" }),
            with: z.strictObject({ tone: z.string() }),
          }),
        ],
        name: "test",
        waitMethods: [defineWaitMethod({ name: "manual", with: z.strictObject({}) })],
      }),
    ],
  });

  it("takes only the extensions of the plugins, and the with of each", () => {
    const schema = createDefinitionJsonSchema({ plugins });
    const steps = "properties.steps.additionalProperties.oneOf";

    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema).toHaveProperty(`${steps}.1.properties.method.enum`, ["manual"]);
    expect(schema).toHaveProperty(`${steps}.1.allOf.0.if.properties.method.const`, "manual");
    expect(schema).toHaveProperty(
      `${steps}.1.allOf.0.then.properties.with.additionalProperties`,
      false,
    );
    expect(schema).toHaveProperty(`${steps}.2.properties.provider.enum`, ["echo"]);
    expect(schema).toHaveProperty(`${steps}.2.allOf.0.then.properties.with.required`, ["tone"]);
    // The settings of the provider need a value, so the step must have with, as validate does.
    expect(schema).toHaveProperty(`${steps}.2.allOf.0.then.required`, ["with"]);
    // An empty with passes the method, so the step may leave it out.
    expect(schema).not.toHaveProperty(`${steps}.1.allOf.0.then.required`);
    // Script steps have no extensions.
    expect(schema).not.toHaveProperty(`${steps}.0.allOf`);
  });

  it("accepts no AI provider when no plugin provides one", () => {
    const schema = createDefinitionJsonSchema({
      plugins: createPluginRegistry({
        builtins: [
          definePlugin({
            name: "test",
            waitMethods: [defineWaitMethod({ name: "manual", with: z.strictObject({}) })],
          }),
        ],
      }),
    });

    // JSON Schema requires at least one value in an enum.
    expect(schema).toHaveProperty(
      "properties.steps.additionalProperties.oneOf.2.properties.provider.not",
      {},
    );
    expect(schema).not.toHaveProperty(
      "properties.steps.additionalProperties.oneOf.2.properties.provider.enum",
    );
    // An empty allOf is not valid JSON Schema either.
    expect(schema).not.toHaveProperty("properties.steps.additionalProperties.oneOf.2.allOf");
  });

  it("accepts $schema in a definition", () => {
    expect(
      definitionSchema.safeParse({
        $schema: "../schemas/workflow.schema.json",
        start: "a",
        steps: { a: { next: "end", run: "true", type: "script" } },
        version: definitionVersion,
      }).success,
    ).toBe(true);
  });
});
