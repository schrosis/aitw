import { createPluginRegistry, definePlugin, defineWaitMethod } from "@aitw/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

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

const waitSource = (ask: string) => `version: v0.1
start: ask
steps:
  ask:
    type: wait
${ask}
    next: end
`;

describe("compileDefinition wait steps", () => {
  const plugins = createPluginRegistry({
    builtins: [
      definePlugin({
        name: "test",
        waitMethods: [
          defineWaitMethod({
            answers: ({ name }) => ({ [name]: { required: true, type: "string" } }),
            name: "ask",
            with: z.strictObject({ message: z.string(), name: z.string() }),
          }),
          defineWaitMethod({ name: "watch", with: z.strictObject({}) }),
          defineWaitMethod({
            answers: () => {
              throw new Error("broken plugin");
            },
            name: "broken",
            with: z.strictObject({}),
          }),
        ],
      }),
    ],
  });

  it("builds the answers from the method", () => {
    expect(
      compileDefinition(
        waitSource(
          "    method: ask\n    with:\n      message: Name?\n      name: who\n    outputs:\n      who: ${{ result.who }}",
        ),
        { plugins },
      ),
    ).toMatchObject({
      intermediate: {
        steps: {
          ask: {
            answers: { who: { required: true, type: "string" } },
            method: "ask",
            type: "wait",
            with: { message: "Name?", name: "who" },
          },
        },
      },
      ok: true,
    });
  });

  it("builds a method without answers", () => {
    const result = compileDefinition(waitSource("    method: watch"), { plugins });

    expect(result).toMatchObject({ intermediate: { steps: { ask: { with: {} } } }, ok: true });
    expect(result.ok && result.intermediate.steps.ask).not.toHaveProperty("answers");
  });

  it("locates an unknown method", () => {
    expect(compileDefinition(waitSource("    method: slack"), { plugins })).toEqual({
      errors: [
        {
          column: 13,
          line: 6,
          message: "Unknown wait method: slack. Available methods: ask, watch, broken",
          path: ["steps", "ask", "method"],
        },
      ],
      ok: false,
    });
    expect(compileDefinition(waitSource("    method: ask"))).toMatchObject({
      errors: [{ message: "Unknown wait method: ask. No methods are available" }],
      ok: false,
    });
  });

  it("reports a method that fails to describe its answers", () => {
    expect(compileDefinition(waitSource("    method: broken"), { plugins })).toMatchObject({
      errors: [
        {
          message: "Wait method broken failed to describe its answers: broken plugin",
          path: ["steps", "ask", "with"],
        },
      ],
      ok: false,
    });
  });

  it("locates invalid options with the schema of the method", () => {
    expect(
      compileDefinition(
        waitSource("    method: ask\n    with:\n      message: 1\n      name: who"),
        {
          plugins,
        },
      ),
    ).toMatchObject({
      errors: [{ column: 16, line: 8, path: ["steps", "ask", "with", "message"] }],
      ok: false,
    });
  });

  it("reports invalid answers at with", () => {
    expect(
      compileDefinition(
        waitSource("    method: ask\n    with:\n      message: Hi\n      name: 1st"),
        {
          plugins,
        },
      ),
    ).toMatchObject({ errors: [{ line: 8, path: ["steps", "ask", "with"] }], ok: false });
  });
});
