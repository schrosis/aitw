import { describe, expect, it } from "vitest";

import { resolveWorkflowInput } from "./input.ts";
import type { InputDeclaration } from "./schema.ts";

const declarations: Record<string, InputDeclaration> = {
  enabled: { default: false, required: false, type: "boolean" },
  level: { options: ["low", "high"], required: true, type: "choice" },
  note: { required: false, type: "string" },
  threshold: { default: 1.5, description: "Minimum score", required: false, type: "number" },
};

describe("resolveWorkflowInput", () => {
  it("applies defaults and uses null for an optional input without a default", () => {
    expect(resolveWorkflowInput(declarations, { level: "high" })).toEqual({
      input: { enabled: false, level: "high", note: null, threshold: 1.5 },
      ok: true,
    });
  });

  it("keeps given values", () => {
    expect(
      resolveWorkflowInput(declarations, {
        enabled: true,
        level: "low",
        note: "hello",
        threshold: -2,
      }),
    ).toEqual({ input: { enabled: true, level: "low", note: "hello", threshold: -2 }, ok: true });
  });

  it("reports unknown, missing, and mistyped values", () => {
    expect(
      resolveWorkflowInput(declarations, { enabled: "yes", extra: 1, note: 3, threshold: "1" }),
    ).toEqual({
      errors: [
        { message: "Unknown input", path: ["extra"] },
        { message: "Must be a boolean", path: ["enabled"] },
        { message: "Required", path: ["level"] },
        { message: "Must be a string", path: ["note"] },
        { message: "Must be a finite number", path: ["threshold"] },
      ],
      ok: false,
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])("rejects the number %d", (threshold) => {
    expect(resolveWorkflowInput(declarations, { level: "low", threshold })).toMatchObject({
      errors: [{ path: ["threshold"] }],
      ok: false,
    });
  });

  it("rejects a value that is not an option", () => {
    expect(resolveWorkflowInput(declarations, { level: "mid" })).toEqual({
      errors: [{ message: "Must be one of low, high", path: ["level"] }],
      ok: false,
    });
  });

  it.each([null, [], "text"])("rejects input that is not an object: %j", (values) => {
    expect(resolveWorkflowInput(declarations, values)).toEqual({
      errors: [{ message: "Must be an object", path: [] }],
      ok: false,
    });
  });
});
