import { describe, expect, it } from "vitest";

import { describeEvents, formatAge } from "./runs.ts";

describe("describeEvents", () => {
  it.each([
    [[], "starting"],
    [[{ run: "make", step: "build", type: "stepStarted" }], "running build"],
    [[{ provider: "claude-code", step: "review", type: "stepStarted" }], "running review"],
    [
      [{ message: "Approve?", step: "approve", type: "stepStarted" }],
      "waiting at approve: Approve?",
    ],
    [[{ step: "approve", type: "stepStarted" }], "waiting at approve"],
    [
      [
        { run: "make", step: "build", type: "stepStarted" },
        { durationMs: 1, outcome: "succeeded", step: "build", type: "stepFinished" },
      ],
      "paused between steps",
    ],
  ] as const)("describes %j as %j", (events, status) => {
    expect(describeEvents(events)).toBe(status);
  });
});

describe("formatAge", () => {
  const now = new Date("2026-11-09T12:00:00Z");

  it.each([
    ["2026-11-09T11:59:30Z", "just now"],
    ["2026-11-09T11:55:00Z", "5m ago"],
    ["2026-11-09T09:00:00Z", "3h ago"],
    ["2026-11-07T12:00:00Z", "2d ago"],
  ])("formats %s as %s", (time, age) => {
    expect(formatAge(new Date(time), now)).toBe(age);
  });
});
