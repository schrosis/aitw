import { definePlugin, defineWaitMethod } from "@ugoke/core";
import type { Plugin, WaitMethod } from "@ugoke/core";

import { githubPrAnswers } from "./answers.js";
import { createGhSource } from "./gh.js";
import { githubConfigSchema, githubPrOptionsSchema, resolveTarget } from "./options.js";
import type { GithubConfig, GithubPrOptions } from "./options.js";
import { pollPullRequest } from "./poll.js";
import type { PollOptions } from "./poll.js";
import type { PullRequestSource } from "./source.js";

export { githubPrAnswers } from "./answers.js";
export type { GithubPrAnswer } from "./answers.js";
export { createGhSource } from "./gh.js";
export type { GhResult, GhRunner, GhSourceOptions } from "./gh.js";
export {
  githubConfigSchema,
  githubPrOptionsSchema,
  minPollIntervalMs,
  pullRequestEvents,
  resolveTarget,
  reviewStates,
} from "./options.js";
export type {
  GithubConfig,
  GithubPrOptions,
  PullRequestEvent,
  PullRequestTarget,
  ReviewState,
} from "./options.js";
export { GithubSourceError } from "./source.js";
export type {
  Check,
  GithubErrorKind,
  GithubSourceErrorOptions,
  PullRequestSnapshot,
  PullRequestSource,
  Review,
} from "./source.js";

/** Options of {@link createGithubPlugin}. */
export interface GithubPluginOptions {
  /** Reads pull requests. Defaults to gh, with its own login. */
  source?: PullRequestSource;
  /** Waits between checks. For tests. */
  sleep?: PollOptions["sleep"];
  /** Returns the current time, for the rate limit. For tests. */
  now?: PollOptions["now"];
}

/** Message of the error when the engine does not tell when the step started to wait. */
const missingStartedAtMessage =
  "This wait method needs a newer ugoke that tells when the step started to wait";

const isValidDate = (value: unknown): value is Date =>
  value instanceof Date && !Number.isNaN(value.getTime());

const createPrMethod = ({
  now,
  sleep,
  source = createGhSource(),
}: GithubPluginOptions): WaitMethod<GithubPrOptions, GithubConfig> =>
  defineWaitMethod({
    answers: () => githubPrAnswers,
    name: "github_pr",
    respond: async ({ config, log, options, signal, startedAt }) => {
      // An older engine of a resident process can load this plugin, and it does not tell the time.
      if (!isValidDate(startedAt)) {
        throw new Error(missingStartedAtMessage);
      }
      const target = resolveTarget(options);
      return pollPullRequest({
        log,
        now,
        options,
        pollIntervalMs: config.pollInterval,
        signal,
        sleep,
        source,
        startedAt,
        target,
      });
    },
    respondIn: "worker",
    with: githubPrOptionsSchema,
  });

/**
 * Creates the plugin that waits for events of GitHub.
 *
 * Its `github_pr` wait method waits until a pull request is merged or closed, its checks
 * complete, or it gets a new review.
 */
export const createGithubPlugin = (options: GithubPluginOptions = {}): Plugin<GithubConfig> =>
  definePlugin({
    config: githubConfigSchema,
    name: "github",
    waitMethods: [createPrMethod(options)],
  });

/** The plugin that waits for events of GitHub with gh. */
export const githubPlugin = createGithubPlugin();

// ugoke loads the default export of the packages that `plugins` in `.ugoke/config.yaml` names.
export default githubPlugin;
