import { createInterface } from "node:readline";

/** Reads lines from a stream, one at a time. */
export interface LineReader {
  /**
   * Reads the next line without its line ending.
   *
   * @returns The line, or `null` when the stream ends.
   * @throws When the signal is aborted before a line arrives.
   */
  readLine: (signal: AbortSignal) => Promise<string | null>;
  /** Stops reading, so that the stream no longer keeps the process alive. */
  close: () => void;
}

/**
 * Creates a line reader for a stream, such as standard input.
 *
 * It reads lines whether or not the stream is a terminal, so that a script or another AI can
 * answer through a pipe.
 */
export const createLineReader = (input: NodeJS.ReadableStream): LineReader => {
  const lines = createInterface({ crlfDelay: Infinity, input, terminal: false });
  const iterator = lines[Symbol.asyncIterator]();
  // A line that arrives after an aborted read is kept for the next read.
  let pending: Promise<IteratorResult<string>> | undefined;

  return {
    close: () => {
      lines.close();
    },
    readLine: async (signal) => {
      signal.throwIfAborted();
      pending ??= iterator.next();
      const next = pending;
      // The same signal is used for every read of a run, so the listener is removed after each.
      const cleanup = new AbortController();
      const aborted = new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
          signal: cleanup.signal,
        });
      });
      try {
        const result = await Promise.race([next, aborted]);
        pending = undefined;
        return result.done === true ? null : result.value;
      } finally {
        cleanup.abort();
      }
    },
  };
};
