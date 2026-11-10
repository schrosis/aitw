/**
 * Maximum size of the values that a step publishes or receives, in bytes of JSON.
 *
 * These values are stored in the workflow history, so the limit matches the size at which
 * Temporal warns about large payloads. It also keeps a payload well below the default limit of
 * 2 MB.
 */
export const maxValueBytes = 512 * 1024;

/** Returns the size of a value in bytes of JSON. */
export const jsonBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * Number of history events at which a run stops, below the limit at which Temporal terminates it.
 */
export const maxHistoryEvents = 40_000;

/** Size of the history in bytes at which a run stops, below the limit of Temporal. */
export const maxHistoryBytes = 40 * 1024 * 1024;

/** Returns why a run must stop because of the size of its history, if it must. */
export const historyLimitMessage = (events: number, bytes: number): string | undefined =>
  events >= maxHistoryEvents || bytes >= maxHistoryBytes
    ? `The history of the run has ${events} events and ${bytes} bytes, which is close to the limit of Temporal. Set maxVisits or shorten the loop`
    : undefined;
