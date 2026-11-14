import { intermediateVersion } from "@aitw/core";
import type { Intermediate, IntermediateStep, Transition } from "@aitw/core";
import { describe, expect, it } from "vitest";

import { documentMarker, renderMermaid, renderWorkflowDocument } from "./document.ts";

const common = { inputs: {}, outputs: {} };

const script = (next: Transition): IntermediateStep => ({
  ...common,
  next,
  run: "./run.sh",
  timeoutMs: 1000,
  type: "script",
});

const workflow = (start: string, steps: Intermediate["steps"]): Intermediate => ({
  inputs: {},
  start,
  steps,
  version: intermediateVersion,
});

const toStep = (step: string): Transition => ({ step, type: "step" });
const end: Transition = { type: "end" };

const branch = (condition: string, step: string): Transition => ({
  branches: [{ if: condition, to: { step, type: "step" } }, { to: { type: "end" } }],
  type: "branch",
});

const labelOf = (condition: string): string =>
  renderMermaid(workflow("a", { a: script(branch(condition, "b")), b: script(end) }))
    .split("\n")
    .find((line) => line.includes("d_a_0{"))
    ?.replace(/^\s*d_a_0\{"/u, "")
    .replace(/"\}$/u, "") ?? "";

describe("renderMermaid", () => {
  it("draws each type of step with its shape, in the order of the definition", () => {
    expect(
      renderMermaid(
        workflow("ask", {
          ask: {
            ...common,
            method: "terminal",
            next: toStep("review"),
            type: "wait",
            with: {},
          },
          review: {
            ...common,
            next: toStep("report"),
            prompt: "Review",
            provider: "claude-code",
            session: "reuse",
            timeoutMs: 1000,
            type: "ai",
            with: {},
          },
          report: script(end),
        }),
      ),
    ).toBe(
      [
        "flowchart TD",
        '  start_(("start"))',
        '  s_ask{{"ask"}}',
        '  s_review(["review"])',
        '  s_report["report"]',
        '  end_(("end"))',
        "  start_ --> s_ask",
        "  s_ask --> s_review",
        "  s_review --> s_report",
        "  s_report --> end_",
      ].join("\n"),
    );
  });

  it("draws each condition as a node, tried in order", () => {
    const next: Transition = {
      branches: [
        { if: "${{ outputs.a == 1 }}", to: { step: "b", type: "step" } },
        { if: "${{ outputs.a == 2 }}", to: { type: "end" } },
        { to: { step: "c", type: "step" } },
      ],
      type: "branch",
    };

    expect(renderMermaid(workflow("a", { a: script(next), b: script(end), c: script(end) }))).toBe(
      [
        "flowchart TD",
        '  start_(("start"))',
        '  s_a["a"]',
        '  d_a_0{"outputs.a == 1"}',
        '  d_a_1{"outputs.a == 2"}',
        '  s_b["b"]',
        '  s_c["c"]',
        '  end_(("end"))',
        "  start_ --> s_a",
        "  s_a --> d_a_0",
        '  d_a_0 -->|"yes"| s_b',
        '  d_a_0 -->|"no"| d_a_1',
        '  d_a_1 -->|"yes"| end_',
        '  d_a_1 -->|"no"| s_c',
        "  s_b --> end_",
        "  s_c --> end_",
      ].join("\n"),
    );
  });

  it("goes straight to the target of a single branch without a condition", () => {
    expect(
      renderMermaid(
        workflow("a", { a: script({ branches: [{ to: { type: "end" } }], type: "branch" }) }),
      ),
    ).toContain("  s_a --> end_");
  });

  it("draws a loop back to an earlier step", () => {
    expect(
      renderMermaid(
        workflow("a", {
          a: script(toStep("b")),
          b: script(branch("${{ outputs.ok == false }}", "a")),
        }),
      ),
    ).toContain('  d_b_0 -->|"yes"| s_a');
  });

  it("escapes only what a quoted label cannot hold", () => {
    expect(labelOf("${{ a == 'x\"y<z>' }}")).toBe("a == 'x#quot;y#lt;z#gt;'");
  });

  it("starts a line at each && and || outside of parentheses", () => {
    expect(labelOf("${{ (a && b) || (c && d) || e && f }}")).toBe(
      "(a && b)<br/>|| (c && d)<br/>|| e<br/>&& f",
    );
  });

  it("does not break inside of a string", () => {
    expect(labelOf("${{ a == 'x || y' && b }}")).toBe("a == 'x || y'<br/>&& b");
  });

  it("keeps the parentheses and quotes of a condition that calls a function", () => {
    expect(labelOf("${{ trim(outputs.x) == 'ok' && outputs.y != 'a&&b' }}")).toBe(
      "trim(outputs.x) == 'ok'<br/>&& outputs.y != 'a&&b'",
    );
  });

  it("writes a condition of several lines as its parts", () => {
    expect(labelOf("${{ a == 1\n  || b == 2 }}")).toBe("a == 1<br/>|| b == 2");
  });

  it("does not shorten a long condition", () => {
    const long = "あ".repeat(60);

    expect(
      renderMermaid(
        workflow("a", { a: script(branch(`\${{ a == '${long}' }}`, "b")), b: script(end) }),
      ),
    ).toContain(`"a == '${long}'"`);
  });

  it("is not broken by a step named after a keyword", () => {
    expect(renderMermaid(workflow("graph", { graph: script(end) }))).toContain('s_graph["graph"]');
  });
});

describe("renderWorkflowDocument", () => {
  it("starts with the marker and holds the diagram in a code block", () => {
    const definition = workflow("a", { a: script(end) });

    expect(renderWorkflowDocument(definition)).toBe(
      `${documentMarker}\n\n\`\`\`mermaid\n${renderMermaid(definition)}\n\`\`\`\n`,
    );
  });
});
