import type { InputDeclaration } from "@ugoke/core";

import { pullRequestEvents, reviewStates } from "./options.js";

/** Values that a `github_pr` step receives, whatever its options are. */
export const githubPrAnswers = {
  event: {
    description: "Event that ended the wait",
    options: [...pullRequestEvents],
    required: false,
    type: "choice",
  },
  url: { description: "URL of the pull request", required: false, type: "string" },
  number: { description: "Number of the pull request", required: false, type: "number" },
  headSha: {
    description: "SHA of the head commit of the pull request when the event was found",
    required: false,
    type: "string",
  },
  occurredAt: {
    description: "When the event happened on GitHub, as ISO 8601",
    required: false,
    type: "string",
  },
  reviewState: {
    description: "State of the review, for the review event",
    options: [...reviewStates],
    required: false,
    type: "choice",
  },
  reviewAuthor: {
    description: "Login of the author of the review, for the review event",
    required: false,
    type: "string",
  },
  reviewBody: {
    description: "Body of the review, for the review event",
    multiline: true,
    required: false,
    type: "string",
  },
  reviewUrl: {
    description: "URL of the review, for the review event",
    required: false,
    type: "string",
  },
  reviewCommit: {
    description: "SHA of the commit that the review is on, for the review event",
    required: false,
    type: "string",
  },
  checksConclusion: {
    description: "success when every check succeeded, or failure, for the checks event",
    options: ["success", "failure"],
    required: false,
    type: "choice",
  },
  failedChecks: {
    description: "Names of the checks that failed, separated by commas, for the checks event",
    required: false,
    type: "string",
  },
} satisfies Readonly<Record<string, InputDeclaration>>;

/** Answers of a `github_pr` step. A missing value becomes `null` in the workflow. */
export type GithubPrAnswer = Partial<
  Record<keyof typeof githubPrAnswers, boolean | number | string>
>;
