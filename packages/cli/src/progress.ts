import type { EventSink, WorkflowEvent } from "@aitw/core";

const formatDuration = (durationMs: number): string => `${(durationMs / 1000).toFixed(1)}s`;

/** Formats a progress event as lines for the terminal. */
export const formatEvent = (event: WorkflowEvent): string => {
  if (event.type === "stepStarted") {
    const run = event.run.endsWith("\n") ? event.run : `${event.run}\n`;
    return `▶ ${event.step}\n${run}`;
  }

  const duration = formatDuration(event.durationMs);
  if (event.outcome === "succeeded") {
    return `✓ ${event.step} (${duration})\n`;
  }
  if (event.outcome === "cancelled") {
    return `■ ${event.step}: cancelled (${duration})\n`;
  }
  return `✗ ${event.step}: ${event.message ?? "failed"} (${duration})\n`;
};

/** Creates an event sink that writes progress to the terminal. */
export const createProgressPrinter = (write: (text: string) => void): EventSink => ({
  emit: (event) => write(formatEvent(event)),
});
