/** Pattern of a duration, such as `30s`, `5m`, or `1h`. */
export const durationPattern = /^[1-9][0-9]*(?:s|m|h)$/u;

/** Message for a value that does not match {@link durationPattern}. */
export const durationMessage = "Must be a positive duration such as 30s, 5m, or 1h";

const millisecondsPerUnit: Readonly<Record<string, number>> = {
  h: 3_600_000,
  m: 60_000,
  s: 1000,
};

/**
 * Converts a duration that matches {@link durationPattern} to milliseconds.
 *
 * @throws Error for a value that does not match it.
 */
export const parseDuration = (duration: string): number => {
  const unit = millisecondsPerUnit[duration.slice(-1)];
  if (!durationPattern.test(duration) || unit === undefined) {
    throw new Error(`Invalid duration: ${duration}. ${durationMessage}`);
  }
  return Number(duration.slice(0, -1)) * unit;
};
