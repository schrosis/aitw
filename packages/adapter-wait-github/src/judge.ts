import type { GithubPrAnswer } from "./answers.js";
import type { AuthorName, GithubPrOptions, PullRequestEvent, ReviewState } from "./options.js";
import { defaultAuthorAssociations, parseAuthorName, reviewStates } from "./options.js";
import type { Check, PullRequestSnapshot, Review, ReviewAuthor } from "./source.js";

/** What a check of a pull request decided. */
export type Judgement =
  | { type: "wait" }
  | { type: "answer"; values: GithubPrAnswer }
  | { type: "fail"; message: string };

const waiting: Judgement = { type: "wait" };

/** Conclusions of a completed check run that count as a success. */
const successfulConclusions: ReadonlySet<string> = new Set(["success", "neutral", "skipped"]);

/** States of a commit status that mean that the status is final. */
const completedStatusStates: ReadonlySet<string> = new Set(["success", "failure", "error"]);

const countedReviewStates: ReadonlySet<string> = new Set(reviewStates);

/** Returns the values that every event answers. */
const answerOf = (
  snapshot: PullRequestSnapshot,
  event: PullRequestEvent,
  occurredAt: string | null,
  values: GithubPrAnswer = {},
): Judgement => ({
  type: "answer",
  values: {
    event,
    headSha: snapshot.headSha,
    number: snapshot.number,
    url: snapshot.url,
    ...(occurredAt === null ? {} : { occurredAt }),
    ...values,
  },
});

const isCompleted = (check: Check): boolean =>
  check.kind === "checkRun" ? check.status === "completed" : completedStatusStates.has(check.state);

const isSuccessful = (check: Check): boolean =>
  check.kind === "checkRun"
    ? check.conclusion !== null && successfulConclusions.has(check.conclusion)
    : check.state === "success";

const completedAtOf = (check: Check): string | null =>
  check.kind === "checkRun" ? check.completedAt : check.createdAt;

/** Returns the latest of ISO 8601 times as they are written, ignoring those that are not times. */
const latestOf = (times: readonly (string | null)[]): string | null => {
  let latest: { time: string; ms: number } | undefined;
  for (const time of times) {
    if (time === null) {
      continue;
    }
    const ms = Date.parse(time);
    if (!Number.isNaN(ms) && (latest === undefined || ms > latest.ms)) {
      latest = { ms, time };
    }
  }
  return latest?.time ?? null;
};

const judgeChecks = (snapshot: PullRequestSnapshot, names: readonly string[]): Judgement => {
  const failedNames: string[] = [];
  const matchedChecks: Check[] = [];
  for (const name of names) {
    // The source returns only the latest result of each check, so checks of the same name are
    // different jobs, such as jobs of the same name in different workflows.
    const checks = snapshot.checks.filter((check) => check.name === name);
    // A name that has not appeared yet is not completed.
    if (checks.length === 0 || !checks.every(isCompleted)) {
      return waiting;
    }
    if (!checks.every(isSuccessful)) {
      failedNames.push(name);
    }
    matchedChecks.push(...checks);
  }
  return answerOf(snapshot, "checks", latestOf(matchedChecks.map(completedAtOf)), {
    checksConclusion: failedNames.length === 0 ? "success" : "failure",
    failedChecks: failedNames.join(", "),
  });
};

/**
 * Whether the author is one of the names of `review.authors`. A name matches only an account of
 * the same kind, a bot or not, and logins are compared without case. A deleted account matches no
 * name.
 */
const matchesAuthor = (author: ReviewAuthor | null, names: readonly AuthorName[]): boolean =>
  author !== null &&
  names.some(
    (name) =>
      name.isBot === author.isBot && name.login.toLowerCase() === author.login.toLowerCase(),
  );

/** Associations whose reviews count, or `undefined` when the association does not matter. */
const countedAssociationsOf = (
  review: GithubPrOptions["review"],
): ReadonlySet<string> | undefined => {
  if (review?.authorAssociations !== undefined) {
    return new Set(review.authorAssociations);
  }
  return review?.authors === undefined ? new Set(defaultAuthorAssociations) : undefined;
};

/** Login of the author as the REST API and the web show it, such as `github-actions[bot]`. */
const reviewAuthorOf = (author: ReviewAuthor | null): string => {
  if (author === null) {
    // The web shows a deleted account as ghost.
    return "ghost";
  }
  return author.isBot ? `${author.login}[bot]` : author.login;
};

/** A review that counts, with the time that it was submitted. */
type CountedReview = Review & { state: ReviewState; submittedAt: string };

const isCountedState = (review: Review): review is Review & { state: ReviewState } =>
  countedReviewStates.has(review.state);

const judgeReviews = (
  snapshot: PullRequestSnapshot,
  options: GithubPrOptions,
  startedAt: Date,
): Judgement => {
  // GitHub tells times in seconds, so a review of the same second as the start of the wait counts.
  const since = Math.floor(startedAt.getTime() / 1000) * 1000;
  const states = options.review?.states;
  const names = options.review?.authors?.map(parseAuthorName);
  const associations = countedAssociationsOf(options.review);
  const newReviews = snapshot.reviews.filter(
    (candidate): candidate is CountedReview =>
      isCountedState(candidate) &&
      candidate.submittedAt !== null &&
      Date.parse(candidate.submittedAt) >= since &&
      (states === undefined || states.includes(candidate.state)) &&
      (names === undefined || matchesAuthor(candidate.author, names)) &&
      // A value that ugoke does not know is in no set, so its review does not count.
      (associations === undefined || associations.has(candidate.authorAssociation)),
  );
  // Reviews are in the order that they were created, and a pending review is submitted later than
  // the reviews created after it, so the earliest submission is not always the first.
  const review = newReviews.reduce<CountedReview | undefined>(
    (earliest, candidate) =>
      earliest === undefined || Date.parse(candidate.submittedAt) < Date.parse(earliest.submittedAt)
        ? candidate
        : earliest,
    undefined,
  );
  if (review === undefined) {
    return waiting;
  }
  return answerOf(snapshot, "review", review.submittedAt, {
    reviewAuthor: reviewAuthorOf(review.author),
    reviewBody: review.body,
    reviewState: review.state,
    reviewUrl: review.url,
    ...(review.commit === null ? {} : { reviewCommit: review.commit }),
  });
};

/**
 * Decides from the state of a pull request whether a `github_pr` step stops waiting.
 *
 * Events are judged in the order of merged, closed, checks, and review, whatever the order of
 * `events` is. A merged or closed pull request fails the step when `events` does not include it.
 *
 * @param startedAt When the step started to wait. Only reviews submitted in or after its second
 *   count.
 */
export const judge = (
  snapshot: PullRequestSnapshot,
  options: GithubPrOptions,
  startedAt: Date,
): Judgement => {
  const { events } = options;
  if (snapshot.state === "merged") {
    return events.includes("merged")
      ? answerOf(snapshot, "merged", snapshot.mergedAt)
      : {
          message: `Pull request ${snapshot.url} was merged, but events does not include merged`,
          type: "fail",
        };
  }
  if (snapshot.state === "closed") {
    return events.includes("closed")
      ? answerOf(snapshot, "closed", snapshot.closedAt)
      : {
          message: `Pull request ${snapshot.url} was closed without merging, but events does not include closed`,
          type: "fail",
        };
  }
  if (events.includes("checks") && options.checks !== undefined) {
    const judgement = judgeChecks(snapshot, options.checks.names);
    if (judgement.type !== "wait") {
      return judgement;
    }
  }
  if (events.includes("review")) {
    return judgeReviews(snapshot, options, startedAt);
  }
  return waiting;
};
