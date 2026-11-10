import { createPluginRegistry, defineAiProvider, definePlugin, defineWaitMethod } from "@aitw/core";
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

const aiSource = (fields: string): string => `version: v0.1
start: review
steps:
  review:
    type: ai
    prompt: Review the change
${fields}
    next: end
`;

describe("compileDefinition for AI steps", () => {
  const plugins = createPluginRegistry({
    builtins: [
      definePlugin({
        aiProviders: [
          defineAiProvider({
            name: "claude-code",
            run: async () => ({ data: "" }),
            with: z.strictObject({ allowedTools: z.array(z.string()).optional() }),
          }),
        ],
        name: "claude",
      }),
    ],
  });

  it("builds a step with its defaults", () => {
    const result = compileDefinition(aiSource("    provider: claude-code"), { plugins });

    expect(result).toMatchObject({
      intermediate: {
        steps: {
          review: {
            prompt: "Review the change",
            provider: "claude-code",
            session: "reuse",
            timeoutMs: 1_800_000,
            type: "ai",
            with: {},
          },
        },
      },
      ok: true,
    });
    expect(result.ok && result.intermediate.steps.review).not.toHaveProperty("model");
    expect(result.ok && result.intermediate.steps.review).not.toHaveProperty("schema");
  });

  it("builds every field", () => {
    const source = aiSource(`    provider: claude-code
    model: claude-opus-5-5
    session: new
    timeout: 5m
    env:
      PORT: 3000
    with:
      allowedTools: [Read]
    schema:
      type: object
      properties:
        verdict:
          type: string
    outputs:
      verdict: \${{ result.data.verdict }}`);

    expect(compileDefinition(source, { plugins })).toMatchObject({
      intermediate: {
        steps: {
          review: {
            env: { PORT: "3000" },
            model: "claude-opus-5-5",
            outputs: { verdict: "${{ result.data.verdict }}" },
            schema: { properties: { verdict: { type: "string" } }, type: "object" },
            session: "new",
            timeoutMs: 300_000,
            with: { allowedTools: ["Read"] },
          },
        },
      },
      ok: true,
    });
  });

  it("locates an unknown provider", () => {
    expect(compileDefinition(aiSource("    provider: codex"), { plugins })).toEqual({
      errors: [
        {
          column: 15,
          line: 7,
          message: "Unknown AI provider: codex. Available providers: claude-code",
          path: ["steps", "review", "provider"],
        },
      ],
      ok: false,
    });
    expect(compileDefinition(aiSource("    provider: codex"))).toMatchObject({
      errors: [{ message: "Unknown AI provider: codex. No providers are available" }],
      ok: false,
    });
  });

  it("locates invalid options of the provider", () => {
    const source = aiSource(`    provider: claude-code
    with:
      allowedTools: Read`);

    expect(compileDefinition(source, { plugins })).toMatchObject({
      errors: [{ line: 9, path: ["steps", "review", "with", "allowedTools"] }],
      ok: false,
    });
  });

  it("rejects an unknown session", () => {
    const source = aiSource(`    provider: claude-code
    session: always`);

    expect(compileDefinition(source, { plugins })).toMatchObject({
      errors: [{ path: ["steps", "review", "session"] }],
      ok: false,
    });
  });
});

const branchSource = (next: string): string => `version: v0.1
start: check
steps:
  check:
    type: script
    run: ./check.sh
    outputs:
      ok: \${{ result.stdout }}
    next:
${next}
  fix:
    type: script
    run: ./fix.sh
    next: end
`;

describe("compileDefinition for branches", () => {
  it("builds branches in order", () => {
    const source = branchSource(`      - if: \${{ outputs.ok == 'no' }}
        to: fix
      - to: end`);

    expect(compileDefinition(source)).toMatchObject({
      intermediate: {
        steps: {
          check: {
            next: {
              branches: [
                { if: "${{ outputs.ok == 'no' }}", to: { step: "fix", type: "step" } },
                { to: { type: "end" } },
              ],
              type: "branch",
            },
          },
        },
      },
      ok: true,
    });
  });

  it("locates a missing last branch at its condition", () => {
    const source = branchSource(`      - if: \${{ outputs.ok == 'no' }}
        to: fix`);

    expect(compileDefinition(source)).toEqual({
      errors: [
        {
          column: 13,
          line: 10,
          message:
            "The last branch must have no if, so that a branch is always taken. Use to: end to finish",
          path: ["steps", "check", "next", 0, "if"],
        },
      ],
      ok: false,
    });
  });

  it("locates an unknown target and an invalid condition", () => {
    const source = branchSource(`      - if: \${{ outputs.ok < 1 }}
        to: fix
      - to: missing`);

    expect(compileDefinition(source)).toMatchObject({
      errors: expect.arrayContaining([
        expect.objectContaining({
          line: 12,
          message: "Unknown step: missing",
          path: ["steps", "check", "next", 1, "to"],
        }),
        expect.objectContaining({ line: 10, path: ["steps", "check", "next", 0, "if"] }),
      ]) as unknown,
      ok: false,
    });
  });

  it("explains what next can be", () => {
    expect(compileDefinition(branchSource("      1"))).toMatchObject({
      errors: [
        {
          message: "Must be the name of a step, end, or a list of branches with if and to",
          path: ["steps", "check", "next"],
        },
      ],
      ok: false,
    });
  });

  it("reports the problem inside of a branch", () => {
    expect(compileDefinition(branchSource("      - to: end\n        when: x"))).toMatchObject({
      errors: [{ message: "Unknown field: when", path: ["steps", "check", "next", 0, "when"] }],
      ok: false,
    });
    expect(compileDefinition(branchSource("      - to: 1"))).toMatchObject({
      errors: [{ path: ["steps", "check", "next", 0, "to"] }],
      ok: false,
    });
  });

  it("reports the problem of a name", () => {
    expect(compileDefinition(branchSource("      fix-1"))).toMatchObject({
      errors: [
        {
          message: expect.stringContaining("Must start with a letter") as unknown,
          path: ["steps", "check", "next"],
        },
      ],
      ok: false,
    });
  });

  it("rejects an empty list and an unknown field", () => {
    expect(compileDefinition(branchSource("      []"))).toMatchObject({ ok: false });
    expect(compileDefinition(branchSource("      - to: end\n        when: x"))).toMatchObject({
      ok: false,
    });
  });
});
