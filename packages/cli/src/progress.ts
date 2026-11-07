import type { EventSink, WorkflowEvent } from "@aitw/core";

/** A progress event that marks the start or the end of a step. */
type StepEvent = Exclude<WorkflowEvent, { type: "stepOutput" }>;

const formatDuration = (durationMs: number): string => `${(durationMs / 1000).toFixed(1)}s`;

/** Formats the start or the end of a step as lines for the terminal. */
export const formatStepEvent = (event: StepEvent): string => {
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

/** Streams that progress is written to. */
export interface ProgressOutput {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/**
 * Creates an event sink that writes progress and script output to the terminal.
 *
 * Script output is written as it arrives, to the same stream that the script used.
 */
export const createProgressPrinter = (output: ProgressOutput): EventSink => {
  // Output that does not end with a newline would otherwise run into the next line.
  let atLineStart = true;

  return {
    emit: (event) => {
      if (event.type === "stepOutput") {
        output[event.stream](event.text);
        if (event.text.length > 0) {
          atLineStart = event.text.endsWith("\n");
        }
        return;
      }
      if (!atLineStart) {
        output.stdout("\n");
        atLineStart = true;
      }
      output.stdout(formatStepEvent(event));
    },
  };
};
