import { describe, expect, it } from "vitest";

import { formatEvent } from "./progress.ts";

describe("formatEvent", () => {
  it("shows the step and its command when it starts", () => {
    expect(formatEvent({ run: 'echo "hoge"', step: "firstStep", type: "stepStarted" })).toBe(
      '▶ firstStep\necho "hoge"\n',
    );
  });

  it("keeps a multiline command as written", () => {
    expect(formatEvent({ run: "echo a\necho b\n", step: "build", type: "stepStarted" })).toBe(
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
    expect(formatEvent({ durationMs: 1234, step: "build", type: "stepFinished", ...fields })).toBe(
      expected,
    );
  });
});
