import { describe, expect, it } from "vitest";

import { checkDotenvPath } from "../identifier.ts";
import { intermediateVersion } from "./schema.ts";
import type { Intermediate } from "./schema.ts";
import { validateIntermediate } from "./validate.ts";

const workflow = (
  fields: Partial<Intermediate>,
  stepEnv?: Record<string, string>,
): Intermediate => ({
  inputs: { level: { required: false, type: "string" } },
  start: "fetch",
  steps: {
    fetch: {
      inputs: {},
      next: { step: "report", type: "step" },
      outputs: { title: "${{ result.stdout }}" },
      run: "./fetch.sh",
      timeoutMs: 1000,
      type: "script",
    },
    report: {
      inputs: { prefix: "${{ workflow.inputs.level }}" },
      next: { type: "end" },
      outputs: {},
      run: "./report.sh",
      timeoutMs: 1000,
      type: "script",
      ...(stepEnv === undefined ? {} : { env: stepEnv }),
    },
  },
  version: intermediateVersion,
  ...fields,
});

const errorsOf = (intermediate: Intermediate) => {
  const result = validateIntermediate(intermediate);
  return result.ok ? [] : result.errors;
};

describe("validateIntermediate env", () => {
  it("accepts an intermediate representation without env, as earlier runs have", () => {
    expect(errorsOf(workflow({}))).toEqual([]);
  });

  it("lets the environment of the workflow reference only the workflow input", () => {
    expect(
      errorsOf(workflow({ env: { LEVEL: "${{ workflow.inputs.level }}", PLAIN: "x" } })),
    ).toEqual([]);
    expect(
      errorsOf(
        workflow({
          env: {
            FROM_STEP: "${{ steps.fetch.outputs.title }}",
            MISSING: "${{ workflow.inputs.missing }}",
          },
        }),
      ),
    ).toEqual([
      {
        message: expect.stringContaining("can reference only workflow.inputs.<name>") as unknown,
        path: ["env", "FROM_STEP"],
      },
      {
        message: expect.stringContaining("does not declare the input missing") as unknown,
        path: ["env", "MISSING"],
      },
    ]);
  });

  it("lets the environment of a step reference what its run can", () => {
    expect(
      errorsOf(
        workflow(
          {},
          {
            LEVEL: "${{ workflow.inputs.level }}",
            PREFIX: "${{ inputs.prefix }}",
            TITLE: "${{ steps.fetch.outputs.title }}",
          },
        ),
      ),
    ).toEqual([]);
    expect(errorsOf(workflow({}, { CODE: "${{ result.exitCode }}" }))).toMatchObject([
      { path: ["steps", "report", "env", "CODE"] },
    ]);
  });

  it("rejects invalid names and dotenv paths", () => {
    expect(errorsOf(workflow({ dotenv: "../secrets.env", env: { "1BAD": "x" } }))).toMatchObject([
      { path: ["env", "1BAD"] },
      { message: "Must not leave the project root", path: ["dotenv"] },
    ]);
  });
});

describe("checkDotenvPath", () => {
  it.each([".env", "config/.env", "./.env.local"])("accepts %s", (path) => {
    expect(checkDotenvPath(path)).toBeUndefined();
  });

  it.each([
    ["/etc/env", "Must be a path relative to the project root"],
    ["C:\\env", "Must be a path relative to the project root"],
    ["../.env", "Must not leave the project root"],
    ["config/../../.env", "Must not leave the project root"],
  ])("rejects %s", (path, message) => {
    expect(checkDotenvPath(path)).toBe(message);
  });
});
