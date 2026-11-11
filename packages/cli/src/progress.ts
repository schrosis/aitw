import type { EventSink, WorkflowEvent } from "@aitw/core";

/** A progress event that marks the start or the end of a step. */
type StepEvent = Exclude<WorkflowEvent, { type: "stepOutput" }>;

const formatDuration = (durationMs: number): string => `${(durationMs / 1000).toFixed(1)}s`;

/** Formats the start or the end of a step as lines for the terminal. */
export const formatStepEvent = (event: StepEvent): string => {
  if (event.type === "stepStarted") {
    if (event.run === undefined) {
      return `▶ ${event.step}\n`;
    }
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
  const continued = event.continued === true ? "continued, " : "";
  return `✗ ${event.step}: ${event.message ?? "failed"} (${continued}${duration})\n`;
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
  // A stream whose output does not end with a newline. Its line is ended before the next step
  // event, on the same stream, so that the output would otherwise not run into the next line.
  let openStream: keyof ProgressOutput | undefined;

  return {
    emit: (event) => {
      if (event.type === "stepOutput") {
        output[event.stream](event.text);
        if (event.text.length > 0) {
          openStream = event.text.endsWith("\n") ? undefined : event.stream;
        }
        return;
      }
      if (openStream !== undefined) {
        output[openStream]("\n");
        openStream = undefined;
      }
      output.stdout(formatStepEvent(event));
    },
  };
};
