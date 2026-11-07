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
