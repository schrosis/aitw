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
  /** Keeps a status line at the bottom of the terminal while a step runs. */
  status?: StatusLineOptions | undefined;
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
    /**
     * Formats the status line of a running step.
     *
     * @param shownStep The name to show, which can be shortened to fit the terminal.
     */
    status: (mark: string, step: string, shownStep: string): string =>
      `${style("dim", mark)} ${style([colorOf(step), "bold"], shownStep)}`,
    /** Styles output of a step, which is dim for the progress of an AI step. */
    output: (text: string, ai: boolean): string => (ai ? style("dim", text) : text),
  };
};

/** Options of the line that stays at the bottom of the terminal while a step runs. */
export interface StatusLineOptions {
  /** Returns the width of the terminal, so that the line does not wrap. */
  columns: () => number;
  /** Returns the current time in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Calls a function at an interval, and returns what stops it. Defaults to `setInterval`, which
   * does not keep the process alive.
   */
  every?: (callback: () => void, intervalMs: number) => () => void;
}

/** Frames of the spinner of the status line. */
const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Interval at which the status line is drawn again. */
const statusIntervalMs = 1000;

/** Clears the line of the cursor, and moves the cursor to its start. */
const clearLine = "\r\u001B[2K";

/** Formats an elapsed time like a clock, such as `0:42`, `12:05`, or `1:02:03`. */
export const formatElapsed = (elapsedMs: number): string => {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return minutes < 60
    ? `${minutes}:${rest}`
    : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${rest}`;
};

const everySecond = (callback: () => void, intervalMs: number): (() => void) => {
  const timer = setInterval(callback, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
};

/** Progress that a command writes, and the status line that it keeps at the bottom. */
export interface ProgressPrinter extends EventSink {
  /**
   * Removes the status line before the command writes something else, such as a message about
   * an interrupt. It is drawn again at the next interval.
   */
  clear: () => void;
  /** Removes the status line for good, when the command stops following the run. */
  close: () => void;
}

/**
 * Creates an event sink that writes progress and step output to the terminal.
 *
 * Output is written as it arrives, to the same stream that the step used, and each of its lines
 * is indented under the step. Output of scripts keeps its own colors.
 *
 * With `status`, a line at the bottom shows the script or AI step that runs and its elapsed
 * time, so that a step that writes nothing for a while still shows that it runs. It is drawn on
 * standard output only between complete lines, and not while a wait step asks.
 */
export const createProgressPrinter = (
  output: ProgressOutput,
  { colors = {}, showCommands = true, status, steps }: ProgressOptions = {},
): ProgressPrinter => {
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

  const now = status?.now ?? Date.now;
  // The script or AI step that runs, which the status line shows.
  let running: { step: string; startedAt: number } | undefined;
  let frame = 0;
  let shown = false;
  let stopTimer: (() => void) | undefined;

  const hide = (): void => {
    if (shown) {
      output.stdout(clearLine);
      shown = false;
    }
  };

  const draw = (): void => {
    // A line that output left open would be overwritten.
    if (status === undefined || running === undefined || open.stdout || open.stderr) {
      return;
    }
    const mark = spinner[frame % spinner.length] ?? "";
    const elapsed = formatElapsed(now() - running.startedAt);
    // The line must not wrap, or clearing it would leave a part of it.
    const room = status.columns() - 1 - `${mark}   ${elapsed}`.length;
    if (room < 1) {
      return;
    }
    const step = running.step.length > room ? `${running.step.slice(0, room - 1)}…` : running.step;
    output.stdout(`${clearLine}${formats.stdout.status(mark, running.step, step)}  ${elapsed}`);
    shown = true;
  };

  /** Writes to a stream, keeping the status line below what is written. */
  const write = (stream: keyof ProgressOutput, text: string): void => {
    hide();
    output[stream](text);
  };

  const writeStep = (event: StepEvent): void => {
    for (const stream of ["stdout", "stderr"] as const) {
      if (open[stream]) {
        write(stream, "\n");
        open[stream] = false;
      }
    }
    if (event.type === "stepStarted") {
      if (event.provider !== undefined) {
        aiSteps.add(event.step);
      }
      // A wait step asks in the terminal, which the status line would get in the way of.
      running =
        event.run === undefined && event.provider === undefined
          ? undefined
          : { startedAt: now(), step: event.step };
    } else {
      running = undefined;
    }
    write("stdout", formats.stdout.step(event));
  };

  if (status !== undefined) {
    stopTimer = (status.every ?? everySecond)(() => {
      frame += 1;
      if (running !== undefined) {
        draw();
      }
    }, statusIntervalMs);
  }

  return {
    clear: hide,
    close: () => {
      stopTimer?.();
      stopTimer = undefined;
      running = undefined;
      hide();
    },
    emit: (event) => {
      if (event.type !== "stepOutput") {
        writeStep(event);
        draw();
        return;
      }
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
      write(event.stream, text);
      open[event.stream] = !event.text.endsWith("\n");
      draw();
    },
  };
};
