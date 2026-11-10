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

  it("labels branches with their conditions, and a loop goes back", () => {
    expect(
      renderMermaid(
        workflow("a", {
          a: script(toStep("b")),
          b: script(branch("${{ outputs.ok == false }}", "a")),
        }),
      ),
    ).toContain(['  s_b -->|"outputs.ok == false"| s_a', '  s_b -->|"else"| end_'].join("\n"));
  });

  it("escapes the characters that a label cannot hold", () => {
    expect(
      renderMermaid(
        workflow("a", { a: script(branch("${{ a == 'x\"y' || b && c }}", "b")), b: script(end) }),
      ),
    ).toContain(`"a == 'x#34;y' #124;#124; b #38;#38; c"`);
  });

  it("writes a condition of several lines on one line", () => {
    expect(
      renderMermaid(
        workflow("a", { a: script(branch("${{ a == 1\n  || b == 2 }}", "b")), b: script(end) }),
      ),
    ).toContain('"a == 1 #124;#124; b == 2"');
  });

  it("shortens a long condition by characters", () => {
    const long = "あ".repeat(60);

    expect(
      renderMermaid(
        workflow("a", { a: script(branch(`\${{ a == '${long}' }}`, "b")), b: script(end) }),
      ),
    ).toContain(`"a == '${"あ".repeat(44)}…"`);
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
