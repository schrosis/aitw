import { describe, expect, it } from "vitest";

import type { GithubPrOptions, PullRequestTarget } from "./options.ts";
import type { PollOptions } from "./poll.ts";
import { maxBackoffMs, maxRateLimitWaitMs, pollPullRequest } from "./poll.ts";
import type { PullRequestSnapshot, PullRequestSource } from "./source.ts";
import { GithubSourceError } from "./source.ts";

const url = "https://github.com/acme/widgets/pull/12";
const target: PullRequestTarget = { name: "widgets", number: 12, owner: "acme" };
const startedAt = new Date("2026-11-14T03:04:05Z");
const pollIntervalMs = 30_000;

const options: GithubPrOptions = { events: ["merged"], pr: url };

const openSnapshot: PullRequestSnapshot = {
  checks: [],
  closedAt: null,
  headSha: "0123456789abcdef0123456789abcdef01234567",
  mergedAt: null,
  number: 12,
  reviews: [],
  state: "open",
  url,
};

const mergedSnapshot: PullRequestSnapshot = {
  ...openSnapshot,
  mergedAt: "2026-11-14T04:00:00Z",
  state: "merged",
};

const closedSnapshot: PullRequestSnapshot = {
  ...openSnapshot,
  closedAt: "2026-11-14T04:00:00Z",
  state: "closed",
};

const mergedAnswer = {
  event: "merged",
  headSha: openSnapshot.headSha,
  number: 12,
  occurredAt: "2026-11-14T04:00:00Z",
  url,
};

type Read = PullRequestSnapshot | Error | ((signal: AbortSignal) => Promise<PullRequestSnapshot>);

/** A source that returns or throws the results in order, and repeats the last one. */
const sourceOf = (results: readonly Read[]): PullRequestSource & { reads: number } => {
  const source = {
    read: async (readTarget: PullRequestTarget, signal: AbortSignal) => {
      expect(readTarget).toBe(target);
      const result = results[Math.min(source.reads, results.length - 1)];
      source.reads += 1;
      if (typeof result === "function") {
        return result(signal);
      }
      if (result instanceof Error) {
        throw result;
      }
      if (result === undefined) {
        throw new Error("No results");
      }
      return result;
    },
    reads: 0,
  };
  return source;
};

const transient = (message = "connect ETIMEDOUT") => new GithubSourceError("transient", message);

/** Runs a poll with a clock that the sleeps advance, and records the sleeps and the log. */
const poll = async (results: readonly Read[], overrides: Partial<PollOptions> = {}) => {
  let clock = Date.parse("2026-11-14T03:04:05Z");
  const sleeps: number[] = [];
  const logs: string[] = [];
  const source = sourceOf(results);
  const run = pollPullRequest({
    log: (message) => logs.push(message),
    now: () => clock,
    options,
    pollIntervalMs,
    signal: new AbortController().signal,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    source,
    startedAt,
    target,
    ...overrides,
  });
  const result = await run.then(
    (answer) => ({ answer, ok: true as const }),
    (error: unknown) => ({ error, ok: false as const }),
  );
  return { logs, reads: source.reads, result, sleeps };
};

describe("pollPullRequest", () => {
  it("checks again at the poll interval until an event happens", async () => {
    const { logs, reads, result, sleeps } = await poll([
      openSnapshot,
      openSnapshot,
      openSnapshot,
      mergedSnapshot,
    ]);

    expect(result).toEqual({ answer: mergedAnswer, ok: true });
    expect(reads).toBe(4);
    expect(sleeps).toEqual([pollIntervalMs, pollIntervalMs, pollIntervalMs]);
    expect(logs).toEqual([]);
  });

  it("answers at the first check without waiting", async () => {
    const { result, sleeps } = await poll([mergedSnapshot]);

    expect(result).toEqual({ answer: mergedAnswer, ok: true });
    expect(sleeps).toEqual([]);
  });

  it("doubles the interval while transient errors continue, up to 5 minutes", async () => {
    const errors = Array.from({ length: 6 }, () => transient());
    const { result, sleeps } = await poll([...errors, mergedSnapshot]);

    expect(result).toEqual({ answer: mergedAnswer, ok: true });
    expect(maxBackoffMs).toBe(300_000);
    expect(sleeps).toEqual([60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
  });

  it("goes back to the poll interval after a success", async () => {
    const { sleeps } = await poll([
      transient(),
      transient(),
      openSnapshot,
      transient(),
      openSnapshot,
      mergedSnapshot,
    ]);

    expect(sleeps).toEqual([60_000, 120_000, pollIntervalMs, 60_000, pollIntervalMs]);
  });

  it("logs the errors and the recovery", async () => {
    const { logs } = await poll([
      transient("connect ETIMEDOUT"),
      transient("HTTP 502"),
      openSnapshot,
      mergedSnapshot,
    ]);

    expect(logs).toEqual([
      "Failed to check pull request acme/widgets#12 (1 in a row), checking again in 1m: connect ETIMEDOUT",
      "Failed to check pull request acme/widgets#12 (2 in a row), checking again in 2m: HTTP 502",
      "Checked pull request acme/widgets#12 again after 2 failures in a row",
    ]);
  });

  it("does not wait shorter than a poll interval longer than 5 minutes", async () => {
    const { sleeps } = await poll([transient(), transient(), openSnapshot, mergedSnapshot], {
      pollIntervalMs: 10 * 60_000,
    });

    expect(sleeps).toEqual([10 * 60_000, 10 * 60_000, 10 * 60_000]);
  });

  it("formats intervals with hours and seconds in the log", async () => {
    const { logs } = await poll([transient(), mergedSnapshot], { pollIntervalMs: 45_500 });

    expect(logs).toEqual([
      "Failed to check pull request acme/widgets#12 (1 in a row), checking again in 1m 31s: connect ETIMEDOUT",
      "Checked pull request acme/widgets#12 again after 1 failure in a row",
    ]);

    const long = await poll([transient(), mergedSnapshot], { pollIntervalMs: 2 * 3_600_000 });

    expect(long.logs[0]).toBe(
      "Failed to check pull request acme/widgets#12 (1 in a row), checking again in 2h: connect ETIMEDOUT",
    );
  });

  describe("rate limits", () => {
    const resetAt = new Date("2026-11-14T03:20:00Z");
    const rateLimited = (reset: Date | null = resetAt) =>
      new GithubSourceError("rateLimited", "API rate limit exceeded", {
        resetAt: reset ?? undefined,
      });

    it("waits until 1 second after the reset", async () => {
      const { logs, result, sleeps } = await poll([rateLimited(), mergedSnapshot]);

      expect(result).toEqual({ answer: mergedAnswer, ok: true });
      // From 03:04:05 to 03:20:01.
      expect(sleeps).toEqual([(15 * 60 + 56) * 1000]);
      expect(logs).toEqual([
        "The rate limit of GitHub is reached while checking pull request acme/widgets#12, checking again after it resets at 2026-11-14T03:20:00.000Z: API rate limit exceeded",
      ]);
    });

    it("does not wait shorter than the poll interval", async () => {
      const { sleeps } = await poll([
        rateLimited(new Date("2026-11-14T03:04:10Z")),
        mergedSnapshot,
      ]);

      expect(sleeps).toEqual([pollIntervalMs]);
    });

    it("does not count a rate limit as an error in a row", async () => {
      const { logs, sleeps } = await poll([
        transient(),
        rateLimited(),
        transient(),
        openSnapshot,
        mergedSnapshot,
      ]);

      expect(sleeps).toEqual([60_000, (15 * 60 + 56) * 1000 - 60_000, 120_000, pollIntervalMs]);
      expect(logs.at(-1)).toBe(
        "Checked pull request acme/widgets#12 again after 2 failures in a row",
      );
    });

    it("waits until a reset an hour later", async () => {
      const { sleeps } = await poll([
        rateLimited(new Date(Date.parse("2026-11-14T03:04:05Z") + maxRateLimitWaitMs)),
        mergedSnapshot,
      ]);

      expect(sleeps).toEqual([maxRateLimitWaitMs + 1000]);
    });

    it("waits as for transient errors when the reset is more than an hour later", async () => {
      // A source that read the reset in milliseconds as seconds.
      const farReset = new Date(Date.parse("2026-11-14T03:04:05Z") * 1000);
      const { logs, result, sleeps } = await poll([
        rateLimited(farReset),
        // 1 second over an hour after the first back-off of 1 minute.
        rateLimited(
          new Date(Date.parse("2026-11-14T03:04:05Z") + 60_000 + maxRateLimitWaitMs + 1000),
        ),
        mergedSnapshot,
      ]);

      expect(result).toEqual({ answer: mergedAnswer, ok: true });
      expect(sleeps).toEqual([60_000, 120_000]);
      expect(logs[0]).toBe(
        `Failed to check pull request acme/widgets#12 (1 in a row), checking again in 1m: API rate limit exceeded (the rate limit is said to reset at ${farReset.toISOString()}, which is too far)`,
      );
    });

    it("waits as for transient errors when the time of the reset is unknown", async () => {
      const { logs, result, sleeps } = await poll([
        rateLimited(null),
        rateLimited(null),
        mergedSnapshot,
      ]);

      expect(result).toEqual({ answer: mergedAnswer, ok: true });
      expect(sleeps).toEqual([60_000, 120_000]);
      expect(logs[0]).toBe(
        "Failed to check pull request acme/widgets#12 (1 in a row), checking again in 1m: API rate limit exceeded",
      );
    });
  });

  it("throws a fatal error as it is", async () => {
    const error = new GithubSourceError("fatal", "Could not resolve to a PullRequest");
    const { reads, result, sleeps } = await poll([openSnapshot, error, mergedSnapshot]);

    expect(result).toEqual({ error, ok: false });
    expect(reads).toBe(2);
    expect(sleeps).toEqual([pollIntervalMs]);
  });

  it("throws an error that is not of the source as it is", async () => {
    const error = new TypeError("Cannot read properties of undefined");
    const { result, sleeps } = await poll([error]);

    expect(result).toEqual({ error, ok: false });
    expect(sleeps).toEqual([]);
  });

  it("throws when the pull request was closed and events does not include it", async () => {
    const { result } = await poll([openSnapshot, closedSnapshot]);

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error).toEqual(
      new Error(
        `Pull request ${url} was closed without merging, but events does not include closed`,
      ),
    );
  });

  describe("abort", () => {
    const reason = new Error("Activity cancelled");

    it("throws the reason of the signal when it is aborted while reading", async () => {
      const controller = new AbortController();
      const read = (signal: AbortSignal) =>
        new Promise<PullRequestSnapshot>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new GithubSourceError("transient", "gh was killed"));
          });
          controller.abort(reason);
        });
      const { result, sleeps } = await poll([read], { signal: controller.signal });

      expect(result).toEqual({ error: reason, ok: false });
      expect(sleeps).toEqual([]);
    });

    it("throws the reason of the signal when it is aborted while sleeping", async () => {
      const controller = new AbortController();
      const { reads, result } = await poll([openSnapshot], {
        signal: controller.signal,
        sleep: async () => {
          controller.abort(reason);
          throw new DOMException("The operation was aborted", "AbortError");
        },
      });

      expect(result).toEqual({ error: reason, ok: false });
      expect(reads).toBe(1);
    });

    it("throws the reason of the signal when it is aborted while backing off", async () => {
      const controller = new AbortController();
      const { result } = await poll([transient()], {
        signal: controller.signal,
        sleep: async () => {
          controller.abort(reason);
          throw new DOMException("The operation was aborted", "AbortError");
        },
      });

      expect(result).toEqual({ error: reason, ok: false });
    });

    it("throws the reason of the signal when it is aborted before the first check", async () => {
      const controller = new AbortController();
      controller.abort(reason);
      const { reads, result } = await poll([mergedSnapshot], { signal: controller.signal });

      expect(result).toEqual({ error: reason, ok: false });
      expect(reads).toBe(0);
    });

    it("throws the reason of the signal from the default sleep", async () => {
      const controller = new AbortController();
      const run = pollPullRequest({
        options,
        pollIntervalMs,
        signal: controller.signal,
        source: sourceOf([openSnapshot]),
        startedAt,
        target,
      });
      setImmediate(() => {
        controller.abort(reason);
      });

      await expect(run).rejects.toBe(reason);
    });
  });
});
