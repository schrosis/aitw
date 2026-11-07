import { describe, expect, it } from "vitest";

import { parseDefinition } from "./parse.ts";

const validSource = `version: v0.1
start: fetch
steps:
  fetch:
    type: script
    run: ./fetch.sh
    next: end
`;

describe("parseDefinition", () => {
  it("returns a validated definition", () => {
    expect(parseDefinition(validSource)).toMatchObject({
      definition: {
        start: "fetch",
        steps: { fetch: { run: "./fetch.sh", timeout: "30m" } },
        version: "v0.1",
      },
      ok: true,
    });
  });

  it("locates a schema error", () => {
    const source = validSource.replace("next: end", "next: end\n    timeout: 5");

    expect(parseDefinition(source)).toMatchObject({
      errors: [{ column: 14, line: 8, path: ["steps", "fetch", "timeout"] }],
      ok: false,
    });
  });

  it("locates a missing field at its parent", () => {
    const source = validSource.replace("    next: end\n", "");

    expect(parseDefinition(source)).toMatchObject({
      errors: [{ column: 5, line: 5, path: ["steps", "fetch", "next"] }],
      ok: false,
    });
  });

  it("locates an unknown field", () => {
    const source = validSource.replace("next: end", "next: end\n    retry: 3");

    expect(parseDefinition(source)).toMatchObject({
      errors: [
        {
          column: 5,
          line: 8,
          message: "Unknown field: retry",
          path: ["steps", "fetch", "retry"],
        },
      ],
      ok: false,
    });
  });

  it("locates an invalid step ID", () => {
    const source = validSource.replace("  fetch:", "  my-step:");

    expect(parseDefinition(source)).toMatchObject({
      errors: [{ column: 3, line: 4 }],
      ok: false,
    });
  });

  it("locates a non-string step ID", () => {
    const source = validSource.replace(
      "    next: end\n",
      "    next: end\n  1:\n    type: script\n    run: ./x.sh\n    next: end\n",
    );

    expect(parseDefinition(source)).toMatchObject({
      errors: [{ column: 3, line: 8 }],
      ok: false,
    });
  });

  it("returns every schema error", () => {
    const source = validSource
      .replace("version: v0.1", "version: v9")
      .replace("start: fetch", "start: end");

    const result = parseDefinition(source);

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? [] : result.errors).toHaveLength(2);
  });

  it("rejects a numeric version", () => {
    expect(parseDefinition(validSource.replace("v0.1", "0.1"))).toMatchObject({
      errors: [{ line: 1, path: ["version"] }],
      ok: false,
    });
  });

  it("reports a syntax error", () => {
    expect(parseDefinition("steps: [")).toMatchObject({ ok: false });
  });

  it("rejects duplicate keys", () => {
    const source = validSource.replace("start: fetch", "start: fetch\nstart: fetch");

    expect(parseDefinition(source)).toMatchObject({
      errors: [{ line: 3 }],
      ok: false,
    });
  });

  it("rejects multiple documents", () => {
    expect(parseDefinition(`${validSource}---\n${validSource}`)).toMatchObject({ ok: false });
  });

  it("rejects anchors and aliases", () => {
    const source = `version: v0.1
start: first
steps:
  first: &step
    type: script
    run: ./step.sh
    next: end
  second: *step
`;

    const result = parseDefinition(source);

    expect(result.ok ? [] : result.errors.map(({ message }) => message)).toEqual([
      "YAML anchors are not supported",
      "YAML aliases are not supported",
    ]);
  });

  it("returns the intermediate representation", () => {
    expect(parseDefinition(validSource)).toMatchObject({
      intermediate: { start: "fetch", steps: { fetch: { next: null, timeoutMs: 1_800_000 } } },
      ok: true,
    });
  });

  it("locates an unknown transition target", () => {
    expect(parseDefinition(validSource.replace("next: end", "next: report"))).toEqual({
      errors: [
        { column: 11, line: 7, message: "Unknown step: report", path: ["steps", "fetch", "next"] },
      ],
      ok: false,
    });
  });

  it("locates an unreachable step at its ID", () => {
    const source = `${validSource}  orphan:\n    type: script\n    run: ./orphan.sh\n    next: end\n`;

    expect(parseDefinition(source)).toEqual({
      errors: [
        {
          column: 3,
          line: 8,
          message: "Step is not reachable from start",
          path: ["steps", "orphan"],
        },
      ],
      ok: false,
    });
  });

  it("rejects an empty source", () => {
    expect(parseDefinition("")).toMatchObject({
      errors: [{ column: 1, line: 1, path: [] }],
      ok: false,
    });
  });
});
