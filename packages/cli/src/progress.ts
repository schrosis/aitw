import { styleText } from "node:util";

import type { EventSink, WorkflowEvent } from "@aitw/core";

/** A progress event that marks the start or the end of a step. */
type StepEvent = Exclude<WorkflowEvent, { type: "stepOutput" }>;

/** A style of `util.styleText`, such as `cyan`. */
type Style = Extract<Parameters<typeof styleText>[0], string>;

/**
 * Colors of the steps, in the order of the steps in the definition.
 *
 * Red and green are left out, because they tell that a step failed or succeeded.
 */
const stepColors: readonly Style[] = [
  "cyan",
  "yellow",
  "magenta",
  "blue",
  "cyanBright",
  "yellowBright",
  "magentaBright",
  "blueBright",
];

/** Prefix of the lines that belong to a step. */
const gutter = "│";

/** Lines of a prompt that are shown. A prompt can be long, so that the rest is counted. */
const promptLines = 5;

/**
 * Returns the colors of steps, in the order of the definition. A step that is not listed gets the
 * next color when it first appears.
 *
 * @param steps IDs of the steps in the order of the definition.
 */
export const createStepColors = (steps: readonly string[] = []): ((step: string) => Style) => {
  const assigned = new Map(steps.map((step, index) => [step, index]));
  return (step) => {
    let index = assigned.get(step);
    if (index === undefined) {
      index = assigned.size;
      assigned.set(step, index);
    }
    return stepColors[index % stepColors.length] ?? "cyan";
  };
};

/** Formats a duration, such as `4.1s`, `1m 02s`, or `1h 05m`. */
export const formatDuration = (durationMs: number): string => {
  if (durationMs < 60_000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}m`;
};

/** Options of {@link createProgressPrinter}. */
export interface ProgressOptions {
  /** Whether to show what a step runs: the run of a script step and the prompt of an AI step. */
  showCommands?: boolean | undefined;
  /** Whether to color the progress on each stream, such as for a terminal. */
  colors?: Readonly<Partial<Record<keyof ProgressOutput, boolean>>> | undefined;
  /**
   * IDs of the steps in the order of the definition, which gives each step its color. A step
   * that is not listed gets the next free color when it first runs.
   */
  steps?: readonly string[] | undefined;
}

/** Streams that progress is written to. */
export interface ProgressOutput {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/**
 * Creates the formatting of progress, which gives each step its color.
 *
 * Without colors, it formats the same text without styles, such as for a file.
 *
 * @param colorOf Returns the color of a step, so that formats of several streams share colors.
 */
export const createProgressFormat = (
  colors: boolean,
  colorOf: (step: string) => Style = createStepColors(),
  showCommands = true,
) => {
  const style = (format: Style | readonly Style[], text: string): string =>
    colors ? styleText(format, text, { validateStream: false }) : text;
  return {
    /** Returns the prefix of a line of a step, such as of its output. */
    prefix: (step: string): string => `${style(colorOf(step), gutter)} `,
    /** Formats the start or the end of a step as lines for the terminal. */
    step: (event: StepEvent): string => {
      const name = style([colorOf(event.step), "bold"], event.step);
      if (event.type === "stepStarted") {
        // What the step runs, or what a wait step asks, is quoted as in Markdown.
        const quote = (text: string, limit = Infinity): string[] => {
          const lines = text.replace(/\n$/u, "").split("\n");
          const shown = lines.slice(0, limit);
          const rest = lines.length - shown.length;
          const more = `… (${rest} more ${rest === 1 ? "line" : "lines"})`;
          return [...shown, ...(rest > 0 ? [more] : [])].map(
            (line) => `${style(colorOf(event.step), gutter)} ${style("dim", `> ${line}`)}`,
          );
        };
        const quoted = [
          ...(showCommands && event.run !== undefined ? quote(event.run) : []),
          ...(showCommands && event.prompt !== undefined ? quote(event.prompt, promptLines) : []),
          ...(event.message === undefined ? [] : quote(event.message)),
        ];
        return [name, ...quoted, ""].join("\n");
      }
      const duration = formatDuration(event.durationMs);
      if (event.outcome === "succeeded") {
        return `${style("green", "✓")} ${name}  ${duration}\n\n`;
      }
      if (event.outcome === "cancelled") {
        return `${style("yellow", "■")} ${name}  cancelled · ${duration}\n\n`;
      }
      const details = [
        event.message ?? "failed",
        ...(event.continued === true ? ["continued"] : []),
        duration,
      ];
      return `${style("red", "✗")} ${name}  ${details.join(" · ")}\n\n`;
    },
    /** Styles output of a step, which is dim for the progress of an AI step. */
    output: (text: string, ai: boolean): string => (ai ? style("dim", text) : text),
  };
};

/**
 * Creates an event sink that writes progress and step output to the terminal.
 *
 * Output is written as it arrives, to the same stream that the step used, and each of its lines
 * is indented under the step. Output of scripts keeps its own colors.
 */
export const createProgressPrinter = (
  output: ProgressOutput,
  { colors = {}, showCommands = true, steps }: ProgressOptions = {},
): EventSink => {
  // Each stream is colored only when it goes to a terminal, and both share the step colors.
  const colorOf = createStepColors(steps);
  const formats = {
    stderr: createProgressFormat(colors.stderr === true, colorOf, showCommands),
    stdout: createProgressFormat(colors.stdout === true, colorOf, showCommands),
  };
  // Streams whose output does not end with a newline. Their lines are ended before the next step
  // event, on the same stream, so that the output does not run into the next line.
  const open: Record<keyof ProgressOutput, boolean> = { stderr: false, stdout: false };
  // Steps that run an AI provider, whose output is progress rather than the output of a tool.
  const aiSteps = new Set<string>();

  return {
    emit: (event) => {
      if (event.type === "stepOutput") {
        if (event.text.length === 0) {
          return;
        }
        const format = formats[event.stream];
        const prefix = format.prefix(event.step);
        // A line starts at the start of the output, unless the previous output on the same
        // stream left its line open.
        const atLineStart = !open[event.stream];
        const lines = event.text.split("\n");
        const text = lines
          .map((line, index) => {
            // The text after the last newline is empty when the output ends with a newline.
            if (index === lines.length - 1 && line === "") {
              return "";
            }
            const start = index > 0 || atLineStart ? prefix : "";
            return `${start}${format.output(line, aiSteps.has(event.step))}`;
          })
          .join("\n");
        output[event.stream](text);
        open[event.stream] = !event.text.endsWith("\n");
        return;
      }
      for (const stream of ["stdout", "stderr"] as const) {
        if (open[stream]) {
          output[stream]("\n");
          open[stream] = false;
        }
      }
      if (event.type === "stepStarted" && event.provider !== undefined) {
        aiSteps.add(event.step);
      }
      output.stdout(formats.stdout.step(event));
    },
  };
};
