import { describe, expect, it } from "vitest";

import { historyLimitMessage, maxHistoryBytes, maxHistoryEvents } from "./limits.ts";

describe("historyLimitMessage", () => {
  it("is absent well below the limits of Temporal", () => {
    expect(historyLimitMessage(100, 1000)).toBeUndefined();
    expect(historyLimitMessage(maxHistoryEvents - 1, maxHistoryBytes - 1)).toBeUndefined();
  });

  it("explains a history with too many events or bytes", () => {
    expect(historyLimitMessage(maxHistoryEvents, 1000)).toContain(`${maxHistoryEvents} events`);
    expect(historyLimitMessage(100, maxHistoryBytes)).toContain(`${maxHistoryBytes} bytes`);
  });

  it("stays below the limits that make Temporal terminate a workflow", () => {
    expect(maxHistoryEvents).toBeLessThan(51_200);
    expect(maxHistoryBytes).toBeLessThan(50 * 1024 * 1024);
  });
});
