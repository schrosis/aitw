import type { PullRequestTarget } from "./options.js";

/** A review of a pull request. */
export interface Review {
  /** Login of the author as the REST API and the web show it, such as `github-actions[bot]`. */
  author: string;
  state: "APPROVED" | "COMMENTED" | "CHANGES_REQUESTED" | "DISMISSED" | "PENDING";
  body: string;
  /** ISO 8601, or `null` for a pending review. */
  submittedAt: string | null;
  url: string;
  /** The commit that the review is on, or `null` when GitHub does not tell it. */
  commit: string | null;
}

/** A check run or a commit status on the head commit. */
export type Check =
  | {
      kind: "checkRun";
      name: string;
      status: "completed" | "pending";
      /** Lowercase, such as `success`, `failure`, or `skipped`, when completed. */
      conclusion: string | null;
      completedAt: string | null;
    }
  | {
      kind: "status";
      /** The context of the status, such as `Claude Review`. */
      name: string;
      /** `expected` for a status that branch protection requires and nobody has set yet. */
      state: "success" | "failure" | "error" | "pending" | "expected";
      /** When the status was set. */
      createdAt: string;
    };

/** The state of a pull request at one check. */
export interface PullRequestSnapshot {
  url: string;
  number: number;
  state: "open" | "closed" | "merged";
  mergedAt: string | null;
  closedAt: string | null;
  headSha: string;
  /** Reviews in the order that they were created. */
  reviews: readonly Review[];
  /** Checks on the head commit. */
  checks: readonly Check[];
}

/** Reads the state of pull requests, such as with gh. */
export interface PullRequestSource {
  /**
   * Reads the state of a pull request.
   *
   * @throws GithubSourceError for a problem that the source can tell, and the reason of the
   *   signal when it is aborted.
   */
  read: (target: PullRequestTarget, signal: AbortSignal) => Promise<PullRequestSnapshot>;
}

/**
 * What a caller does about an error of a source.
 *
 * - `transient`: Network errors and server errors. Check again later.
 * - `rateLimited`: The rate limit is reached. Check again at `resetAt`.
 * - `fatal`: Anything else, such as no login or no pull request. The step fails.
 */
export type GithubErrorKind = "transient" | "rateLimited" | "fatal";

/** Options of {@link GithubSourceError}. */
export interface GithubSourceErrorOptions {
  /** When the rate limit resets, for `rateLimited`, if the source knows it. */
  resetAt?: Date | undefined;
  cause?: unknown;
}

/** An error of a {@link PullRequestSource} that tells the caller what to do about it. */
export class GithubSourceError extends Error {
  override readonly name = "GithubSourceError";

  /** What the caller does about the error. */
  readonly kind: GithubErrorKind;

  /** When the rate limit resets, for `rateLimited`, if the source knows it. */
  readonly resetAt: Date | undefined;

  constructor(kind: GithubErrorKind, message: string, options: GithubSourceErrorOptions = {}) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.kind = kind;
    this.resetAt = options.resetAt;
  }
}
