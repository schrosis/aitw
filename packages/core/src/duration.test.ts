import { describe, expect, it } from "vitest";

import { durationMessage, durationPattern, parseDuration } from "./index.ts";

describe("durationPattern", () => {
  it.each(["30s", "5m", "1h", "120s"])("accepts %s", (duration) => {
    expect(durationPattern.test(duration)).toBe(true);
  });

  it.each(["0s", "1d", "01s", "1.5m", "", "s", "-1s", "1 s", "1S"])("rejects %j", (duration) => {
    expect(durationPattern.test(duration)).toBe(false);
  });
});

describe("parseDuration", () => {
  it.each([
    ["30s", 30_000],
    ["5m", 300_000],
    ["1h", 3_600_000],
  ])("converts %s to %d milliseconds", (duration, milliseconds) => {
    expect(parseDuration(duration)).toBe(milliseconds);
  });

  it.each(["0s", "1d", "01s", "1.5m", ""])("throws for %j", (duration) => {
    expect(() => parseDuration(duration)).toThrow(
      new Error(`Invalid duration: ${duration}. ${durationMessage}`),
    );
  });
});
