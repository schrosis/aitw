import { describe, expect, it } from "vitest";

import { compileDefinition } from "./compile.ts";

const validSource = `version: v0.1
start: fetch
steps:
  fetch:
    type: script
    run: ./fetch.sh
    next: end
`;

describe("compileDefinition", () => {
  it("returns the intermediate representation", () => {
    expect(compileDefinition(validSource)).toMatchObject({
      intermediate: {
        start: "fetch",
        steps: { fetch: { next: { type: "end" }, timeoutMs: 1_800_000 } },
      },
      ok: true,
    });
  });

  it("locates an unknown transition target", () => {
    expect(compileDefinition(validSource.replace("next: end", "next: report"))).toEqual({
      errors: [
        { column: 11, line: 7, message: "Unknown step: report", path: ["steps", "fetch", "next"] },
      ],
      ok: false,
    });
  });

  it("locates an unreachable step at its ID", () => {
    const source = `${validSource}  orphan:\n    type: script\n    run: ./orphan.sh\n    next: end\n`;

    expect(compileDefinition(source)).toEqual({
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

  it("returns parse errors", () => {
    expect(compileDefinition("")).toMatchObject({ ok: false });
  });

  it("locates an invalid reference in a definition", () => {
    const source = validSource.replace(
      "    next: end\n",
      "    inputs:\n      title: ${{ steps.missing.outputs.title }}\n    next: end\n",
    );

    expect(compileDefinition(source)).toEqual({
      errors: [
        {
          column: 14,
          line: 8,
          message: "Step missing does not run before fetch: ${{ steps.missing.outputs.title }}",
          path: ["steps", "fetch", "inputs", "title"],
        },
      ],
      ok: false,
    });
  });
});
