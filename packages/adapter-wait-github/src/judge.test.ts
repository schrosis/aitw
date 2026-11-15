import { describe, expect, it } from "vitest";

import { judge } from "./judge.ts";
import type { GithubPrOptions } from "./options.ts";
import type { Check, PullRequestSnapshot, Review } from "./source.ts";

const url = "https://github.com/acme/widgets/pull/12";
const headSha = "0123456789abcdef0123456789abcdef01234567";

// The step started to wait 500 ms after 03:04:05.
const startedAt = new Date("2026-11-14T03:04:05.500Z");

const snapshotOf = (snapshot: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  checks: [],
  closedAt: null,
  headSha,
  mergedAt: null,
  number: 12,
  reviews: [],
  state: "open",
  url,
  ...snapshot,
});

const optionsOf = (options: Partial<GithubPrOptions>): GithubPrOptions => ({
  events: ["review"],
  pr: url,
  ...options,
});

const reviewOf = (review: Partial<Review> = {}): Review => ({
  author: "octocat",
  body: "Looks good",
  commit: "fedcba9876543210fedcba9876543210fedcba98",
  state: "COMMENTED",
  submittedAt: "2026-11-14T03:10:00Z",
  url: `${url}#pullrequestreview-1`,
  ...review,
});

const checkRunOf = (
  name: string,
  conclusion: string | null = "success",
  completedAt: string | null = "2026-11-14T03:00:00Z",
): Check => ({
  completedAt: conclusion === null ? null : completedAt,
  conclusion,
  kind: "checkRun",
  name,
  status: conclusion === null ? "pending" : "completed",
});

const statusOf = (
  name: string,
  state: "success" | "failure" | "error" | "pending" | "expected" = "success",
  createdAt = "2026-11-14T03:00:00Z",
): Check => ({ createdAt, kind: "status", name, state });

const allEvents: GithubPrOptions["events"] = ["review", "checks", "closed", "merged"];

const judgeChecks = (checks: readonly Check[], names: string[] = ["test", "Claude Review"]) =>
  judge(snapshotOf({ checks }), optionsOf({ checks: { names }, events: ["checks"] }), startedAt);

const judgeReviews = (reviews: readonly Review[], review?: GithubPrOptions["review"]) =>
  judge(
    snapshotOf({ reviews }),
    optionsOf({ events: ["review"], ...(review === undefined ? {} : { review }) }),
    startedAt,
  );

describe("judge", () => {
  describe("order", () => {
    const snapshot = snapshotOf({
      checks: [checkRunOf("test")],
      mergedAt: "2026-11-14T03:20:00Z",
      reviews: [reviewOf()],
      state: "merged",
    });

    it("judges a merge before checks and reviews", () => {
      const options = optionsOf({ checks: { names: ["test"] }, events: allEvents });

      expect(judge(snapshot, options, startedAt)).toMatchObject({
        type: "answer",
        values: { event: "merged" },
      });
    });

    it("judges a merge before checks and reviews that the step waits for", () => {
      const options = optionsOf({ checks: { names: ["test"] }, events: ["review", "checks"] });

      expect(judge(snapshot, options, startedAt)).toEqual({
        message: `Pull request ${url} was merged, but events does not include merged`,
        type: "fail",
      });
    });

    it("judges checks before reviews", () => {
      const options = optionsOf({ checks: { names: ["test"] }, events: ["review", "checks"] });

      expect(judge({ ...snapshot, state: "open" }, options, startedAt)).toMatchObject({
        type: "answer",
        values: { event: "checks" },
      });
    });

    it("judges reviews while checks are not completed", () => {
      const options = optionsOf({ checks: { names: ["lint"] }, events: ["review", "checks"] });

      expect(judge({ ...snapshot, state: "open" }, options, startedAt)).toMatchObject({
        type: "answer",
        values: { event: "review" },
      });
    });

    it("waits when nothing has happened", () => {
      const options = optionsOf({ checks: { names: ["test"] }, events: allEvents });

      expect(judge(snapshotOf(), options, startedAt)).toEqual({ type: "wait" });
    });
  });

  describe("merged and closed", () => {
    it("answers a merge before the start of the wait", () => {
      const snapshot = snapshotOf({
        closedAt: "2026-11-14T01:00:00Z",
        mergedAt: "2026-11-14T01:00:00Z",
        state: "merged",
      });

      expect(judge(snapshot, optionsOf({ events: ["merged"] }), startedAt)).toEqual({
        type: "answer",
        values: {
          event: "merged",
          headSha,
          number: 12,
          occurredAt: "2026-11-14T01:00:00Z",
          url,
        },
      });
    });

    it("answers a close before the start of the wait", () => {
      const snapshot = snapshotOf({ closedAt: "2026-11-14T01:00:00Z", state: "closed" });

      expect(judge(snapshot, optionsOf({ events: ["closed"] }), startedAt)).toEqual({
        type: "answer",
        values: {
          event: "closed",
          headSha,
          number: 12,
          occurredAt: "2026-11-14T01:00:00Z",
          url,
        },
      });
    });

    it("does not answer a merge as a close", () => {
      const snapshot = snapshotOf({ mergedAt: "2026-11-14T01:00:00Z", state: "merged" });

      expect(judge(snapshot, optionsOf({ events: ["closed"] }), startedAt)).toEqual({
        message: `Pull request ${url} was merged, but events does not include merged`,
        type: "fail",
      });
    });

    it("fails for a close that the step does not wait for", () => {
      const snapshot = snapshotOf({ closedAt: "2026-11-14T01:00:00Z", state: "closed" });

      expect(judge(snapshot, optionsOf({ events: ["merged", "review"] }), startedAt)).toEqual({
        message: `Pull request ${url} was closed without merging, but events does not include closed`,
        type: "fail",
      });
    });
  });

  describe("checks", () => {
    it("answers checks that completed before the start of the wait", () => {
      expect(
        judgeChecks([
          checkRunOf("test", "success", "2026-11-14T01:00:00Z"),
          statusOf("Claude Review", "success", "2026-11-14T02:00:00Z"),
        ]),
      ).toEqual({
        type: "answer",
        values: {
          checksConclusion: "success",
          event: "checks",
          failedChecks: "",
          headSha,
          number: 12,
          occurredAt: "2026-11-14T02:00:00Z",
          url,
        },
      });
    });

    it("waits for a name that has not appeared", () => {
      expect(judgeChecks([checkRunOf("test"), statusOf("Other")])).toEqual({ type: "wait" });
    });

    it("matches names with case", () => {
      expect(judgeChecks([checkRunOf("test"), statusOf("claude review")])).toEqual({
        type: "wait",
      });
    });

    it("waits for a pending check run", () => {
      expect(judgeChecks([checkRunOf("test", null), statusOf("Claude Review")])).toEqual({
        type: "wait",
      });
    });

    it.each(["pending", "expected"] as const)("waits for a %s status", (state) => {
      expect(judgeChecks([checkRunOf("test"), statusOf("Claude Review", state)])).toEqual({
        type: "wait",
      });
    });

    it("waits until every check run of the same name completes", () => {
      expect(judgeChecks([checkRunOf("test"), checkRunOf("test", null)], ["test"])).toEqual({
        type: "wait",
      });
    });

    it("fails a name when one of its check runs fails", () => {
      expect(
        judgeChecks([checkRunOf("test"), checkRunOf("test", "failure")], ["test"]),
      ).toMatchObject({
        type: "answer",
        values: { checksConclusion: "failure", failedChecks: "test" },
      });
    });

    it("succeeds a name when all of its check runs succeed", () => {
      expect(
        judgeChecks([checkRunOf("test"), checkRunOf("test", "skipped")], ["test"]),
      ).toMatchObject({
        type: "answer",
        values: { checksConclusion: "success", failedChecks: "" },
      });
    });

    it.each(["success", "neutral", "skipped"])("counts %s as a success", (conclusion) => {
      expect(judgeChecks([checkRunOf("test", conclusion)], ["test"])).toMatchObject({
        type: "answer",
        values: { checksConclusion: "success", failedChecks: "" },
      });
    });

    it.each(["failure", "cancelled", "timed_out", "action_required", "stale", "startup_failure"])(
      "counts the %s conclusion as a failure",
      (conclusion) => {
        expect(judgeChecks([checkRunOf("test", conclusion)], ["test"])).toMatchObject({
          type: "answer",
          values: { checksConclusion: "failure", failedChecks: "test" },
        });
      },
    );

    it.each(["failure", "error"] as const)("counts the %s status as a failure", (state) => {
      expect(judgeChecks([statusOf("Claude Review", state)], ["Claude Review"])).toMatchObject({
        type: "answer",
        values: { checksConclusion: "failure", failedChecks: "Claude Review" },
      });
    });

    it("lists failed names in the order of checks.names", () => {
      expect(
        judgeChecks(
          [
            statusOf("Claude Review", "error"),
            checkRunOf("lint"),
            checkRunOf("test", "failure"),
            checkRunOf("build", "cancelled"),
          ],
          ["test", "lint", "build", "Claude Review"],
        ),
      ).toMatchObject({
        type: "answer",
        values: { checksConclusion: "failure", failedChecks: "test, build, Claude Review" },
      });
    });

    it("answers the latest completion as occurredAt", () => {
      expect(
        judgeChecks(
          [
            checkRunOf("test", "success", "2026-11-14T03:00:00Z"),
            checkRunOf("test", "success", "2026-11-14T03:30:00Z"),
            statusOf("Claude Review", "success", "2026-11-14T03:15:00Z"),
            checkRunOf("unrelated", "success", "2026-11-14T04:00:00Z"),
          ],
          ["test", "Claude Review"],
        ),
      ).toMatchObject({ type: "answer", values: { occurredAt: "2026-11-14T03:30:00Z" } });
    });

    it("does not answer the values of reviews", () => {
      const judgement = judge(
        snapshotOf({ checks: [checkRunOf("test")], reviews: [reviewOf()] }),
        optionsOf({ checks: { names: ["test"] }, events: ["checks", "review"] }),
        startedAt,
      );

      expect(judgement.type === "answer" && Object.keys(judgement.values).toSorted()).toEqual([
        "checksConclusion",
        "event",
        "failedChecks",
        "headSha",
        "number",
        "occurredAt",
        "url",
      ]);
    });
  });

  describe("review", () => {
    it("answers a new review", () => {
      expect(judgeReviews([reviewOf()])).toEqual({
        type: "answer",
        values: {
          event: "review",
          headSha,
          number: 12,
          occurredAt: "2026-11-14T03:10:00Z",
          reviewAuthor: "octocat",
          reviewBody: "Looks good",
          reviewCommit: "fedcba9876543210fedcba9876543210fedcba98",
          reviewState: "COMMENTED",
          reviewUrl: `${url}#pullrequestreview-1`,
          url,
        },
      });
    });

    it("does not answer the commit of a review that GitHub does not tell", () => {
      const judgement = judgeReviews([reviewOf({ commit: null })]);

      expect(judgement).toMatchObject({ type: "answer", values: { event: "review" } });
      expect(judgement.type === "answer" && judgement.values).not.toHaveProperty("reviewCommit");
    });

    it("does not count a review before the start of the wait", () => {
      expect(judgeReviews([reviewOf({ submittedAt: "2026-11-14T03:04:04Z" })])).toEqual({
        type: "wait",
      });
    });

    it("counts a review in the same second as the start of the wait", () => {
      expect(judgeReviews([reviewOf({ submittedAt: "2026-11-14T03:04:05Z" })])).toMatchObject({
        type: "answer",
        values: { occurredAt: "2026-11-14T03:04:05Z" },
      });
    });

    it("does not count a dismissed review", () => {
      expect(judgeReviews([reviewOf({ state: "DISMISSED" })])).toEqual({ type: "wait" });
    });

    it.each([null, "2026-11-14T03:10:00Z"])(
      "does not count a pending review submitted at %s",
      (submittedAt) => {
        expect(judgeReviews([reviewOf({ state: "PENDING", submittedAt })])).toEqual({
          type: "wait",
        });
      },
    );

    it.each(["APPROVED", "COMMENTED", "CHANGES_REQUESTED"] as const)(
      "counts an %s review",
      (state) => {
        expect(judgeReviews([reviewOf({ state })])).toMatchObject({
          type: "answer",
          values: { reviewState: state },
        });
      },
    );

    it("counts only the states of review.states", () => {
      const reviews = [
        reviewOf({ state: "COMMENTED", submittedAt: "2026-11-14T03:10:00Z" }),
        reviewOf({ state: "APPROVED", submittedAt: "2026-11-14T03:20:00Z" }),
      ];

      expect(judgeReviews(reviews, { states: ["APPROVED", "CHANGES_REQUESTED"] })).toMatchObject({
        type: "answer",
        values: { occurredAt: "2026-11-14T03:20:00Z", reviewState: "APPROVED" },
      });
      expect(judgeReviews(reviews, { states: ["CHANGES_REQUESTED"] })).toEqual({ type: "wait" });
    });

    it("counts only the authors of review.authors", () => {
      const reviews = [
        reviewOf({ author: "octocat", submittedAt: "2026-11-14T03:10:00Z" }),
        reviewOf({ author: "hubot", submittedAt: "2026-11-14T03:20:00Z" }),
      ];

      expect(judgeReviews(reviews, { authors: ["monalisa", "hubot"] })).toMatchObject({
        type: "answer",
        values: { reviewAuthor: "hubot" },
      });
      expect(judgeReviews(reviews, { authors: ["monalisa"] })).toEqual({ type: "wait" });
    });

    it.each([
      ["github-actions", "github-actions[bot]"],
      ["github-actions[bot]", "github-actions[bot]"],
      ["github-actions[bot]", "github-actions"],
    ])("treats the author %s and the review of %s as the same person", (author, login) => {
      expect(judgeReviews([reviewOf({ author: login })], { authors: [author] })).toMatchObject({
        type: "answer",
        values: { reviewAuthor: login },
      });
    });

    it("does not treat a login that only starts with the author as the same person", () => {
      expect(
        judgeReviews([reviewOf({ author: "github-actions-bot" })], { authors: ["github-actions"] }),
      ).toEqual({ type: "wait" });
    });

    it("compares authors without case", () => {
      expect(
        judgeReviews([reviewOf({ author: "Claude[bot]" })], { authors: ["CLAUDE"] }),
      ).toMatchObject({ type: "answer", values: { reviewAuthor: "Claude[bot]" } });
    });

    it("answers the earliest of the new reviews", () => {
      const reviews = [
        reviewOf({ submittedAt: "2026-11-14T03:00:00Z", url: `${url}#pullrequestreview-1` }),
        reviewOf({ submittedAt: "2026-11-14T03:10:00Z", url: `${url}#pullrequestreview-2` }),
        reviewOf({ submittedAt: "2026-11-14T03:20:00Z", url: `${url}#pullrequestreview-3` }),
      ];

      expect(judgeReviews(reviews)).toMatchObject({
        type: "answer",
        values: { reviewUrl: `${url}#pullrequestreview-2` },
      });
    });

    it("answers the earliest submission over the order that the reviews were created", () => {
      // The first review was pending and was submitted after the second one.
      const reviews = [
        reviewOf({ submittedAt: "2026-11-14T03:20:00Z", url: `${url}#pullrequestreview-1` }),
        reviewOf({ submittedAt: "2026-11-14T03:10:00Z", url: `${url}#pullrequestreview-2` }),
      ];

      expect(judgeReviews(reviews)).toMatchObject({
        type: "answer",
        values: { occurredAt: "2026-11-14T03:10:00Z", reviewUrl: `${url}#pullrequestreview-2` },
      });
    });

    it("does not answer the values of checks", () => {
      const judgement = judge(
        snapshotOf({ checks: [checkRunOf("test", null)], reviews: [reviewOf()] }),
        optionsOf({ checks: { names: ["test"] }, events: ["checks", "review"] }),
        startedAt,
      );

      expect(judgement.type === "answer" && Object.keys(judgement.values).toSorted()).toEqual([
        "event",
        "headSha",
        "number",
        "occurredAt",
        "reviewAuthor",
        "reviewBody",
        "reviewCommit",
        "reviewState",
        "reviewUrl",
        "url",
      ]);
    });
  });

  it("answers the head of the snapshot for every event", () => {
    const options = optionsOf({ checks: { names: ["test"] }, events: allEvents });
    const snapshots = [
      snapshotOf({ mergedAt: "2026-11-14T01:00:00Z", state: "merged" }),
      snapshotOf({ closedAt: "2026-11-14T01:00:00Z", state: "closed" }),
      snapshotOf({ checks: [checkRunOf("test")] }),
      snapshotOf({ reviews: [reviewOf({ commit: "another" })] }),
    ];

    for (const snapshot of snapshots) {
      expect(judge(snapshot, options, startedAt)).toMatchObject({
        type: "answer",
        values: { headSha },
      });
    }
  });
});
