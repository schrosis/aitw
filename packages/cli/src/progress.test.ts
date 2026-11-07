import type { WorkflowEvent } from "@aitw/core";
import { describe, expect, it } from "vitest";

import { createProgressPrinter, formatStepEvent } from "./progress.ts";

describe("formatStepEvent", () => {
  it("shows the step and its command when it starts", () => {
    expect(formatStepEvent({ run: 'echo "hoge"', step: "firstStep", type: "stepStarted" })).toBe(
      '▶ firstStep\necho "hoge"\n',
    );
  });

  it("keeps a multiline command as written", () => {
    expect(formatStepEvent({ run: "echo a\necho b\n", step: "build", type: "stepStarted" })).toBe(
      "▶ build\necho a\necho b\n",
    );
  });

  it.each([
    [{ outcome: "succeeded" as const }, "✓ build (1.2s)\n"],
    [
      { message: "Script exited with code 3", outcome: "failed" as const },
      "✗ build: Script exited with code 3 (1.2s)\n",
    ],
    [{ outcome: "cancelled" as const }, "■ build: cancelled (1.2s)\n"],
  ])("shows how a step finished", (fields, expected) => {
    expect(
      formatStepEvent({ durationMs: 1234, step: "build", type: "stepFinished", ...fields }),
    ).toBe(expected);
  });
});

const print = (events: WorkflowEvent[]) => {
  const written: string[] = [];
  const printer = createProgressPrinter({
    stderr: (text) => written.push(`[err]${text}`),
    stdout: (text) => written.push(text),
  });
  for (const event of events) {
    printer.emit(event);
  }
  return written.join("");
};

describe("createProgressPrinter", () => {
  it("writes script output between the start and the end of a step", () => {
    expect(
      print([
        { run: 'echo "hoge"', step: "firstStep", type: "stepStarted" },
        { step: "firstStep", stream: "stdout", text: "hoge\n", type: "stepOutput" },
        { step: "firstStep", stream: "stderr", text: "warn\n", type: "stepOutput" },
        { durationMs: 1200, outcome: "succeeded", step: "firstStep", type: "stepFinished" },
      ]),
    ).toBe('▶ firstStep\necho "hoge"\nhoge\n[err]warn\n✓ firstStep (1.2s)\n');
  });

  it("ends a partial line before the next step event", () => {
    expect(
      print([
        { run: "printf hoge", step: "firstStep", type: "stepStarted" },
        { step: "firstStep", stream: "stdout", text: "hoge", type: "stepOutput" },
        { durationMs: 0, outcome: "succeeded", step: "firstStep", type: "stepFinished" },
      ]),
    ).toBe("▶ firstStep\nprintf hoge\nhoge\n✓ firstStep (0.0s)\n");
  });

  it("ends a partial line on the stream that wrote it", () => {
    expect(
      print([
        { run: "printf warn >&2", step: "firstStep", type: "stepStarted" },
        { step: "firstStep", stream: "stderr", text: "warn", type: "stepOutput" },
        { durationMs: 0, outcome: "succeeded", step: "firstStep", type: "stepFinished" },
      ]),
    ).toBe("▶ firstStep\nprintf warn >&2\n[err]warn[err]\n✓ firstStep (0.0s)\n");
  });
});
