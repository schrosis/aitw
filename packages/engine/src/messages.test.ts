import { describe, expect, it } from "vitest";

import { readStartedAt } from "./messages.ts";

describe("readStartedAt", () => {
  const fallbackMs = Date.parse("2026-01-02T03:04:05.678Z");

  it("reads the time that the workflow reports", () => {
    expect(readStartedAt("2026-03-04T05:06:07.890Z", fallbackMs)).toEqual(
      new Date("2026-03-04T05:06:07.890Z"),
    );
  });

  it.each([
    ["is missing", undefined],
    ["is not a date", "yesterday"],
    ["is empty", ""],
  ])("uses the fallback when the time %s", (_case, startedAt) => {
    expect(readStartedAt(startedAt, fallbackMs)).toEqual(new Date(fallbackMs));
  });
});
