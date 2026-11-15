import { setTimeout } from "node:timers/promises";

import type { GithubPrAnswer } from "./answers.js";
import { judge } from "./judge.js";
import type { GithubPrOptions, PullRequestTarget } from "./options.js";
import type { PullRequestSnapshot, PullRequestSource } from "./source.js";
import { GithubSourceError } from "./source.js";

/** Options of {@link pollPullRequest}. */
export interface PollOptions {
  source: PullRequestSource;
  target: PullRequestTarget;
  options: GithubPrOptions;
  /** When the step started to wait. */
  startedAt: Date;
  /** Interval between checks while nothing happens. */
  pollIntervalMs: number;
  signal: AbortSignal;
  /** Waits, and rejects with the reason of the signal when it is aborted. */
  sleep?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
  /** Current time, for the rate limit. */
  now?: (() => number) | undefined;
  /** Writes a line to the log of the Worker. Nothing is written when it is omitted. */
  log?: ((message: string) => void) | undefined;
}

/** Longest interval while errors continue, unless the poll interval is longer. */
export const maxBackoffMs = 5 * 60_000;

/** Time after the reset of the rate limit before checking again, for differences of clocks. */
const rateLimitMarginMs = 1000;

/**
 * Longest wait for the reset of the rate limit. GitHub resets rate limits within an hour, so a
 * later reset is waited for as a transient error.
 */
export const maxRateLimitWaitMs = 60 * 60_000;

const defaultSleep = async (ms: number, signal: AbortSignal): Promise<void> => {
  await setTimeout(ms, undefined, { signal });
};

const doNothing = (): void => {};

/** Formats a duration such as `1m 30s`, rounding up to seconds. */
const formatDuration = (ms: number): string => {
  const totalSeconds = Math.max(Math.ceil(ms / 1000), 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [
    ...(hours > 0 ? [`${hours}h`] : []),
    ...(minutes > 0 ? [`${minutes}m`] : []),
    ...(seconds > 0 || totalSeconds === 0 ? [`${seconds}s`] : []),
  ];
  return parts.join(" ");
};

const formatTarget = (target: PullRequestTarget): string =>
  `${target.owner}/${target.name}#${target.number}`;

/** Returns the interval after `errorCount` errors in a row. */
const backoffMs = (pollIntervalMs: number, errorCount: number): number =>
  Math.min(pollIntervalMs * 2 ** errorCount, Math.max(maxBackoffMs, pollIntervalMs));

/**
 * Checks a pull request until an event of a `github_pr` step happens, and returns the answers.
 *
 * Errors of the source that may go away, such as of the network, do not fail the step. The
 * interval gets longer while they continue, and the rate limit is waited for until it resets.
 *
 * @throws Error when the pull request was merged or closed and `events` does not include it.
 * @throws GithubSourceError of the kind `fatal`, and any error that is not a
 *   {@link GithubSourceError}, as it is.
 * @throws The reason of the signal when it is aborted.
 */
export const pollPullRequest = async (options: PollOptions): Promise<GithubPrAnswer> => {
  const { pollIntervalMs, signal, source, startedAt, target } = options;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const log = options.log ?? doNothing;
  const pullRequest = formatTarget(target);
  let errorCount = 0;

  const wait = async (ms: number): Promise<void> => {
    try {
      await sleep(ms, signal);
    } catch (error) {
      // The default sleep rejects with an AbortError, not with the reason of the signal.
      signal.throwIfAborted();
      throw error;
    }
  };

  const backOff = async (message: string): Promise<void> => {
    errorCount += 1;
    const ms = backoffMs(pollIntervalMs, errorCount);
    log(
      `Failed to check pull request ${pullRequest} (${errorCount} in a row), checking again in ${formatDuration(ms)}: ${message}`,
    );
    await wait(ms);
  };

  for (;;) {
    signal.throwIfAborted();
    let snapshot: PullRequestSnapshot;
    try {
      snapshot = await source.read(target, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof GithubSourceError) || error.kind === "fatal") {
        throw error;
      }
      const resetAt = error.kind === "rateLimited" ? error.resetAt : undefined;
      const untilResetMs = resetAt === undefined ? undefined : resetAt.getTime() - now();
      if (
        resetAt !== undefined &&
        untilResetMs !== undefined &&
        untilResetMs <= maxRateLimitWaitMs
      ) {
        const ms = Math.max(untilResetMs + rateLimitMarginMs, pollIntervalMs);
        log(
          `The rate limit of GitHub is reached while checking pull request ${pullRequest}, checking again after it resets at ${resetAt.toISOString()}: ${error.message}`,
        );
        await wait(ms);
      } else if (resetAt === undefined) {
        // A rate limit without the time of the reset, such as a secondary rate limit, is waited
        // for as a transient error.
        await backOff(error.message);
      } else {
        // GitHub resets rate limits within an hour, so a later reset is a misreading of the
        // source. Waiting for it could exceed what setTimeout can wait.
        await backOff(
          `${error.message} (the rate limit is said to reset at ${resetAt.toISOString()}, which is too far)`,
        );
      }
      continue;
    }

    if (errorCount > 0) {
      log(
        `Checked pull request ${pullRequest} again after ${errorCount} ${errorCount === 1 ? "failure" : "failures"} in a row`,
      );
      errorCount = 0;
    }
    const judgement = judge(snapshot, options.options, startedAt);
    if (judgement.type === "answer") {
      return judgement.values;
    }
    if (judgement.type === "fail") {
      throw new Error(judgement.message);
    }
    await wait(pollIntervalMs);
  }
};
