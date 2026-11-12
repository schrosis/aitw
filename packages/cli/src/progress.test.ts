import { stripVTControlCharacters } from "node:util";

import type { WorkflowEvent } from "@aitw/core";
import { describe, expect, it } from "vitest";

import {
  createProgressFormat,
  createProgressPrinter,
  createStepColors,
  formatDuration,
} from "./progress.ts";
import type { ProgressOptions } from "./progress.ts";

describe("formatDuration", () => {
  it.each([
    [0, "0.0s"],
    [4123, "4.1s"],
    [59_949, "59.9s"],
    [62_300, "1m 02s"],
    [3_599_000, "59m 59s"],
    [3_900_000, "1h 05m"],
  ])("formats %d ms as %s", (durationMs, expected) => {
    expect(formatDuration(durationMs)).toBe(expected);
  });
});

describe("createProgressFormat", () => {
  const format = createProgressFormat(false);

  it("shows the step, and quotes what it runs", () => {
    expect(format.step({ run: 'echo "hoge"', step: "build", type: "stepStarted" })).toBe(
      'build\n│ > echo "hoge"\n',
    );
    expect(format.step({ run: "echo a\necho b\n", step: "build", type: "stepStarted" })).toBe(
      "build\n│ > echo a\n│ > echo b\n",
    );
    expect(format.step({ step: "ask", type: "stepStarted" })).toBe("ask\n");
  });

  it("quotes the first lines of a prompt, and the message of a wait step", () => {
    const prompt = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n");

    expect(
      format.step({ prompt, provider: "claude-code", step: "review", type: "stepStarted" }),
    ).toBe(
      [
        "review",
        "│ > line 1",
        "│ > line 2",
        "│ > line 3",
        "│ > line 4",
        "│ > line 5",
        "│ > … (3 more lines)",
        "",
      ].join("\n"),
    );
    expect(
      format.step({ message: "Approve?\nSee the plan", step: "ask", type: "stepStarted" }),
    ).toBe("ask\n│ > Approve?\n│ > See the plan\n");
  });

  it("hides what a step runs, but not what a wait step asks, when asked", () => {
    const quiet = createProgressFormat(false, createStepColors(), false);

    expect(quiet.step({ run: "make", step: "build", type: "stepStarted" })).toBe("build\n");
    expect(
      quiet.step({
        prompt: "Review",
        provider: "claude-code",
        step: "review",
        type: "stepStarted",
      }),
    ).toBe("review\n");
    expect(quiet.step({ message: "Approve?", step: "ask", type: "stepStarted" })).toBe(
      "ask\n│ > Approve?\n",
    );
  });

  it.each([
    [{ outcome: "succeeded" as const }, "✓ build  1.2s\n\n"],
    [
      { message: "Script exited with code 3", outcome: "failed" as const },
      "✗ build  Script exited with code 3 · 1.2s\n\n",
    ],
    [
      { continued: true, message: "Script exited with code 3", outcome: "failed" as const },
      "✗ build  Script exited with code 3 · continued · 1.2s\n\n",
    ],
    [{ outcome: "cancelled" as const }, "■ build  cancelled · 1.2s\n\n"],
  ])("shows how a step finished", (fields, expected) => {
    expect(format.step({ durationMs: 1234, step: "build", type: "stepFinished", ...fields })).toBe(
      expected,
    );
  });

  it("colors each step in the order of the definition, and the outcome", () => {
    const colored = createProgressFormat(true, createStepColors(["fetch", "build"]));

    // The second step of the definition gets the second color, even when it runs first.
    expect(colored.step({ run: "make", step: "build", type: "stepStarted" })).toBe(
      "\u001B[33m\u001B[1mbuild\u001B[22m\u001B[39m\n\u001B[33m│\u001B[39m \u001B[2m> make\u001B[22m\n",
    );
    expect(colored.prefix("fetch")).toBe("\u001B[36m│\u001B[39m ");
    // A step that the definition does not list gets the next color.
    expect(colored.prefix("other")).toBe("\u001B[35m│\u001B[39m ");
    const finished = colored.step({
      durationMs: 0,
      outcome: "succeeded",
      step: "fetch",
      type: "stepFinished",
    });
    expect(finished.startsWith("\u001B[32m✓\u001B[39m ")).toBe(true);
  });
});

const print = (events: WorkflowEvent[], options: ProgressOptions = {}) => {
  const written: string[] = [];
  const printer = createProgressPrinter(
    {
      stderr: (text) => written.push(`[err]${text}`),
      stdout: (text) => written.push(text),
    },
    options,
  );
  for (const event of events) {
    printer.emit(event);
  }
  return written.join("");
};

describe("createProgressPrinter", () => {
  it("indents the output of a step, on the stream that the step used", () => {
    expect(
      print([
        { run: 'echo "hoge"', step: "firstStep", type: "stepStarted" },
        { step: "firstStep", stream: "stdout", text: "hoge\nfuga\n", type: "stepOutput" },
        { step: "firstStep", stream: "stderr", text: "warn\n", type: "stepOutput" },
        { durationMs: 1200, outcome: "succeeded", step: "firstStep", type: "stepFinished" },
      ]),
    ).toBe('firstStep\n│ > echo "hoge"\n│ hoge\n│ fuga\n[err]│ warn\n✓ firstStep  1.2s\n\n');
  });

  it("continues a line that the previous output left open", () => {
    expect(
      print([
        { run: "printf", step: "firstStep", type: "stepStarted" },
        { step: "firstStep", stream: "stdout", text: "ho", type: "stepOutput" },
        { step: "firstStep", stream: "stderr", text: "warn\n", type: "stepOutput" },
        { step: "firstStep", stream: "stdout", text: "ge\nnext", type: "stepOutput" },
        { durationMs: 0, outcome: "succeeded", step: "firstStep", type: "stepFinished" },
      ]),
    ).toBe("firstStep\n│ > printf\n│ ho[err]│ warn\nge\n│ next\n✓ firstStep  0.0s\n\n");
  });

  it("ends a partial line on the stream that wrote it", () => {
    expect(
      print([
        { run: "printf warn >&2", step: "firstStep", type: "stepStarted" },
        { step: "firstStep", stream: "stderr", text: "warn", type: "stepOutput" },
        { durationMs: 0, outcome: "succeeded", step: "firstStep", type: "stepFinished" },
      ]),
    ).toBe("firstStep\n│ > printf warn >&2\n[err]│ warn[err]\n✓ firstStep  0.0s\n\n");
  });

  it("dims the progress of an AI step, and keeps the colors of script output", () => {
    const colored = print(
      [
        { provider: "claude-code", step: "review", type: "stepStarted" },
        { step: "review", stream: "stdout", text: "Read a.ts\n", type: "stepOutput" },
        { run: "pnpm test", step: "test", type: "stepStarted" },
        {
          step: "test",
          stream: "stdout",
          text: "\u001B[32mpassed\u001B[39m\n",
          type: "stepOutput",
        },
      ],
      { colors: { stdout: true } },
    );

    expect(colored).toContain("\u001B[2mRead a.ts\u001B[22m\n");
    expect(colored).toContain(" \u001B[32mpassed\u001B[39m\n");
    expect(stripVTControlCharacters(colored)).toBe(
      "review\n│ Read a.ts\ntest\n│ > pnpm test\n│ passed\n",
    );
  });

  it("colors each stream only when it goes to a terminal", () => {
    const written = print(
      [
        { run: "make", step: "build", type: "stepStarted" },
        { step: "build", stream: "stderr", text: "warn\n", type: "stepOutput" },
        { step: "build", stream: "stdout", text: "done\n", type: "stepOutput" },
      ],
      { colors: { stdout: true } },
    );

    // Standard error goes to a file here, so its lines have no escape sequences.
    expect(written).toContain("[err]│ warn\n");
    expect(written).toContain("\u001B[36m│\u001B[39m done\n");
  });
});
