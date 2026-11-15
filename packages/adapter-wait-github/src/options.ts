import { durationMessage, durationPattern, parseDuration } from "@ugoke/core";
import { z } from "zod";

/** Events that a step can wait for, in the order that they are judged. */
export const pullRequestEvents = ["merged", "closed", "checks", "review"] as const;

/** An event of a pull request that a step can wait for. */
export type PullRequestEvent = (typeof pullRequestEvents)[number];

/** States of a review that a step can count. */
export const reviewStates = ["APPROVED", "COMMENTED", "CHANGES_REQUESTED"] as const;

/** A state of a review that a step can count. */
export type ReviewState = (typeof reviewStates)[number];

const pullRequestUrlPattern =
  /^https:\/\/github\.com\/(?<owner>[A-Za-z0-9-]+)\/(?<name>[A-Za-z0-9._-]+)\/pull\/(?<number>[1-9][0-9]*)\/?$/u;
const pullRequestNumberPattern = /^[1-9][0-9]*$/u;
const repositoryPattern = /^(?<owner>[A-Za-z0-9-]+)\/(?<name>[A-Za-z0-9._-]+)$/u;

const prMessage =
  "Must be a pull request URL such as https://github.com/owner/repo/pull/1, or its number";
const repoMessage = "Must be owner/repo";
const repoRequiredMessage = "Required when pr is a number";

// Definitions are validated before their expressions are evaluated, so values with expressions
// skip the checks of their form. They are checked again after the evaluation.
const hasExpression = (value: string): boolean => value.includes("${{");

/** How the `pr` field names a pull request. */
type PrForm =
  | { kind: "expression" }
  | { kind: "invalid" }
  | { kind: "number"; number: number }
  | { kind: "url"; owner: string; name: string; number: number };

const toSafeNumber = (digits: string): number | undefined => {
  const number = Number(digits);
  return Number.isSafeInteger(number) ? number : undefined;
};

const readPr = (pr: number | string): PrForm => {
  if (typeof pr === "number") {
    return { kind: "number", number: pr };
  }
  if (hasExpression(pr)) {
    return { kind: "expression" };
  }
  if (pullRequestNumberPattern.test(pr)) {
    const number = toSafeNumber(pr);
    return number === undefined ? { kind: "invalid" } : { kind: "number", number };
  }
  const groups = pullRequestUrlPattern.exec(pr)?.groups;
  const number = groups?.number === undefined ? undefined : toSafeNumber(groups.number);
  if (groups?.owner === undefined || groups.name === undefined || number === undefined) {
    return { kind: "invalid" };
  }
  return { kind: "url", name: groups.name, number, owner: groups.owner };
};

/** Reports each element that repeats an earlier element of the same list. */
const checkDuplicates = (
  context: z.core.$RefinementCtx,
  values: readonly string[],
  path: readonly (number | string)[],
  label: string,
): void => {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate ${label}: ${value}`,
        path: [...path, index],
      });
    }
    seen.add(value);
  });
};

const optionsObjectSchema = z.strictObject({
  message: z.string().min(1).optional().describe("Message that the progress of the run shows"),
  pr: z
    .union([z.int().positive(), z.string().min(1)])
    .describe(
      "URL of the pull request, such as https://github.com/owner/repo/pull/1, or its number",
    ),
  repo: z.string().min(1).optional().describe("owner/repo. Required when pr is a number"),
  events: z.array(z.enum(pullRequestEvents)).min(1).describe("Events to wait for"),
  review: z
    .strictObject({
      authors: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe("Logins of the people whose reviews count. Anyone counts when it is omitted"),
      states: z
        .array(z.enum(reviewStates))
        .min(1)
        .optional()
        .describe("States of the reviews that count. Every state counts when it is omitted"),
    })
    .optional()
    .describe("Which reviews count. Used only when events includes review"),
  checks: z
    .strictObject({
      names: z
        .array(z.string().min(1))
        .min(1)
        .describe("Names of the check runs or the contexts of the commit statuses to wait for"),
    })
    .optional()
    .describe("Which checks to wait for. Required when events includes checks"),
});

/** Checks what the types of the fields cannot express, such as which fields go together. */
const checkCombinations = (
  options: z.output<typeof optionsObjectSchema>,
  context: z.core.$RefinementCtx,
): void => {
  const pr = readPr(options.pr);
  if (pr.kind === "invalid") {
    context.addIssue({ code: "custom", message: prMessage, path: ["pr"] });
  }
  if (
    options.repo !== undefined &&
    !hasExpression(options.repo) &&
    !repositoryPattern.test(options.repo)
  ) {
    context.addIssue({ code: "custom", message: repoMessage, path: ["repo"] });
  }
  if (pr.kind === "number" && options.repo === undefined) {
    context.addIssue({ code: "custom", message: repoRequiredMessage, path: ["repo"] });
  }
  if (pr.kind === "url" && options.repo !== undefined) {
    context.addIssue({
      code: "custom",
      message: "Cannot be used when pr is a URL",
      path: ["repo"],
    });
  }
  checkDuplicates(context, options.events, ["events"], "event");
  if (options.review?.states !== undefined) {
    checkDuplicates(context, options.review.states, ["review", "states"], "state");
  }
  if (options.review !== undefined && !options.events.includes("review")) {
    context.addIssue({
      code: "custom",
      message: "Can be used only when events includes review",
      path: ["review"],
    });
  }
  if (options.checks !== undefined && !options.events.includes("checks")) {
    context.addIssue({
      code: "custom",
      message: "Can be used only when events includes checks",
      path: ["checks"],
    });
  }
  if (options.checks === undefined && options.events.includes("checks")) {
    context.addIssue({
      code: "custom",
      message: "Required when events includes checks",
      path: ["checks"],
    });
  }
};

/** Schema of the `with` field of a `github_pr` step. */
export const githubPrOptionsSchema = optionsObjectSchema.superRefine(checkCombinations);

/** Options of a `github_pr` step. */
export type GithubPrOptions = z.output<typeof githubPrOptionsSchema>;

/** A pull request on github.com. */
export interface PullRequestTarget {
  owner: string;
  name: string;
  number: number;
}

/**
 * Returns the pull request of options whose expressions are evaluated.
 *
 * @throws Error when `pr` or `repo` is still an expression, which happens only when the value of
 *   an expression contains `${{`.
 */
export const resolveTarget = (options: GithubPrOptions): PullRequestTarget => {
  const pr = readPr(options.pr);
  if (pr.kind === "url") {
    return { name: pr.name, number: pr.number, owner: pr.owner };
  }
  if (pr.kind !== "number") {
    throw new Error(`pr: ${prMessage}`);
  }
  if (options.repo === undefined) {
    throw new Error(`repo: ${repoRequiredMessage}`);
  }
  const groups = repositoryPattern.exec(options.repo)?.groups;
  if (groups?.owner === undefined || groups.name === undefined) {
    throw new Error(`repo: ${repoMessage}`);
  }
  return { name: groups.name, number: pr.number, owner: groups.owner };
};

/** Shortest interval between checks of GitHub. */
export const minPollIntervalMs = 10_000;

/** Longest interval between checks of GitHub. */
export const maxPollIntervalMs = 168 * 60 * 60_000;

/** Schema of the settings of the `github` plugin in `.ugoke/config.yaml`. */
export const githubConfigSchema = z.strictObject({
  pollInterval: z
    .string()
    .regex(durationPattern, durationMessage)
    .default("30s")
    .transform(parseDuration)
    .refine((ms) => ms >= minPollIntervalMs, "Must be 10s or longer")
    .refine((ms) => ms <= maxPollIntervalMs, "Must be 168h or shorter")
    .describe("Interval between checks of GitHub, such as 30s or 1m"),
});

/** Settings of the `github` plugin, with the interval in milliseconds. */
export type GithubConfig = z.output<typeof githubConfigSchema>;
