import { spawn } from "node:child_process";
import { constants } from "node:os";

import { z } from "zod";

import type { PullRequestTarget } from "./options.js";
import type {
  Check,
  PullRequestSnapshot,
  PullRequestSource,
  Review,
  ReviewAuthor,
} from "./source.js";
import { GithubSourceError } from "./source.js";

/** Result of a run of gh. */
export interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs gh with arguments, without a shell.
 *
 * @throws GithubSourceError (`fatal`) when gh is not found, and the reason of the signal when it
 *   is aborted.
 */
export type GhRunner = (args: readonly string[], signal: AbortSignal) => Promise<GhResult>;

/** Options of {@link createGhRunner}. */
export interface GhRunnerOptions {
  /** Environment variables that gh inherits, and whose `PATH` finds gh. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Longest time that a run may take. A longer run is stopped as a `transient` error. */
  timeoutMs?: number | undefined;
  /** Largest standard output of a run. A larger one stops the run as a `fatal` error. */
  maxOutputBytes?: number | undefined;
  /** Time to wait after SIGTERM before sending SIGKILL to a run that is stopped. */
  killGraceMs?: number | undefined;
}

/** Longest time that a run of gh may take by default. */
export const defaultGhTimeoutMs = 60_000;

/**
 * Largest standard output of gh by default. Bodies of 100 reviews fit even when every body has
 * the longest length of 65,536 characters.
 */
export const defaultGhMaxOutputBytes = 32 * 1024 * 1024;

const defaultKillGraceMs = 5000;

/** Only the beginning of the standard error is kept, because messages include only a part of it. */
const maxStderrBytes = 64 * 1024;

const ghNotFoundMessage =
  "gh was not found in the PATH of the Worker. The resident process uses the environment where " +
  "ugoke daemon start ran; install gh there, or restart the resident process from a shell whose " +
  "PATH has gh";

/** Variables that keep gh from asking questions or decorating its output. */
const ghEnvironment = {
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_PROMPT_DISABLED: "1",
  NO_COLOR: "1",
} as const;

const errorCode = (error: unknown): unknown =>
  error instanceof Error && "code" in error ? error.code : undefined;

/** Exit code of a process that a signal ended, in the way that shells report it. */
const exitCodeOf = (code: number | null, signalName: NodeJS.Signals | null): number => {
  if (code !== null) {
    return code;
  }
  return 128 + (signalName === null ? 0 : constants.signals[signalName]);
};

/** Creates a {@link GhRunner}. Tests give it small limits and an environment of their own. */
export const createGhRunner =
  ({
    env = process.env,
    killGraceMs = defaultKillGraceMs,
    maxOutputBytes = defaultGhMaxOutputBytes,
    timeoutMs = defaultGhTimeoutMs,
  }: GhRunnerOptions = {}): GhRunner =>
  (args, signal) =>
    new Promise<GhResult>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }

      const child = spawn("gh", args, {
        env: { ...env, ...ghEnvironment },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      const stderr: Buffer[] = [];
      let stderrBytes = 0;
      /** Why the run was stopped, when it was. The run fails with it once gh exits. */
      let stopReason: { error: unknown } | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      let exited = false;

      /**
       * Fails a stopped run once gh has exited. The output of a stopped run is not used, and
       * processes that gh left behind may hold the pipes open, so the run does not wait for them
       * to close.
       */
      const failIfStoppedAndExited = (): void => {
        if (stopReason === undefined || !exited) {
          return;
        }
        child.stdout.destroy();
        child.stderr.destroy();
        const { error } = stopReason;
        settle(() => reject(error));
      };

      const stop = (error: unknown): void => {
        if (stopReason !== undefined) {
          return;
        }
        stopReason = { error };
        if (exited) {
          failIfStoppedAndExited();
          return;
        }
        child.kill("SIGTERM");
        // The timer must not keep the Worker process alive.
        killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs).unref();
      };

      const onAbort = (): void => stop(signal.reason);

      const timeoutTimer = setTimeout(() => {
        stop(
          new GithubSourceError(
            "transient",
            `Could not reach GitHub: gh did not finish within ${timeoutMs / 1000} seconds`,
          ),
        );
      }, timeoutMs);
      signal.addEventListener("abort", onAbort, { once: true });

      const settle = (finish: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(killTimer);
        signal.removeEventListener("abort", onAbort);
        finish();
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutputBytes) {
          stop(
            new GithubSourceError(
              "fatal",
              `The output of gh is larger than ${maxOutputBytes} bytes, the most that is read`,
            ),
          );
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrBytes < maxStderrBytes) {
          stderr.push(chunk.subarray(0, maxStderrBytes - stderrBytes));
          stderrBytes += chunk.length;
        }
      });

      child.on("error", (error) => {
        if (child.pid !== undefined) {
          // gh started, and a signal could not be sent to it. The run ends when gh exits.
          return;
        }
        // gh could not start, and the run ends here.
        settle(() => {
          if (errorCode(error) === "ENOENT") {
            reject(new GithubSourceError("fatal", ghNotFoundMessage, { cause: error }));
          } else {
            reject(
              new GithubSourceError("fatal", `Could not run gh: ${error.message}`, {
                cause: error,
              }),
            );
          }
        });
      });
      child.on("exit", () => {
        exited = true;
        failIfStoppedAndExited();
      });
      child.on("close", (code, signalName) => {
        settle(() => {
          if (stopReason !== undefined) {
            reject(stopReason.error);
            return;
          }
          resolve({
            exitCode: exitCodeOf(code, signalName),
            stderr: Buffer.concat(stderr).toString("utf8"),
            stdout: Buffer.concat(stdout).toString("utf8"),
          });
        });
      });
    });

/** Runs gh in the environment of the Worker. */
export const runGh: GhRunner = createGhRunner();

/** Fields of a check run and of a commit status that a query reads. */
const checkFields = `__typename
                  ... on CheckRun { name status conclusion completedAt }
                  ... on StatusContext { context state createdAt }`;

/** Number of checks that a query reads at a time, the most that GitHub returns. */
const checksPerPage = 100;

/**
 * The query that reads a pull request at each check. When the head commit has more checks than
 * a page, {@link checksPageQuery} reads the rest.
 */
export const pullRequestQuery = `query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      url
      number
      state
      mergedAt
      closedAt
      headRefOid
      reviews(last: 100) {
        nodes {
          author { __typename login }
          authorAssociation
          state
          body
          submittedAt
          url
          commit { oid }
        }
      }
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              contexts(first: ${checksPerPage}) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  ${checkFields}
                }
              }
            }
          }
        }
      }
    }
  }
}`;

/** The query that reads the checks of a commit after a page that {@link pullRequestQuery} read. */
export const checksPageQuery = `query ($owner: String!, $name: String!, $oid: GitObjectID!, $after: String!) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) {
      ... on Commit {
        statusCheckRollup {
          contexts(first: ${checksPerPage}, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              ${checkFields}
            }
          }
        }
      }
    }
  }
}`;

/** Returns the arguments of gh that read a pull request. */
export const pullRequestArgs = (target: PullRequestTarget): string[] => [
  "api",
  "graphql",
  "-f",
  `query=${pullRequestQuery}`,
  "-f",
  `owner=${target.owner}`,
  "-f",
  `name=${target.name}`,
  "-F",
  `number=${target.number}`,
];

/** Returns the arguments of gh that read the checks of a commit after a cursor. */
export const checksPageArgs = (target: PullRequestTarget, oid: string, after: string): string[] => [
  "api",
  "graphql",
  "-f",
  `query=${checksPageQuery}`,
  "-f",
  `owner=${target.owner}`,
  "-f",
  `name=${target.name}`,
  "-f",
  `oid=${oid}`,
  "-f",
  `after=${after}`,
];

/** Arguments of gh that read the rate limits. Reading them does not count against them. */
export const rateLimitArgs: readonly string[] = ["api", "rate_limit"];

// GraphQL lists may contain null for items that could not be resolved, and they are skipped.
const nodesOf = <T extends z.ZodType>(node: T) =>
  z
    .object({ nodes: z.array(node.nullable()) })
    .transform(({ nodes }) =>
      nodes.filter((item): item is NonNullable<z.output<T>> => item !== null),
    );

// The schemas convert the output to the types of source.ts, such as the uppercase states of
// GraphQL to lowercase ones.

/** The key of GraphQL that tells the type of an object. */
const typename = "__typename";

/** The author of a review, or `null` when the account was deleted. */
const authorSchema = z
  .object({ [typename]: z.string(), login: z.string() })
  .nullable()
  .transform((author): ReviewAuthor | null =>
    // Only a bot is a bot. Users, mannequins, and other kinds of accounts are not.
    author === null ? null : { isBot: author[typename] === "Bot", login: author.login },
  );

const reviewSchema = z
  .object({
    author: authorSchema,
    // A string rather than an enum, so that a value that GitHub adds does not fail the read.
    authorAssociation: z.string(),
    body: z.string(),
    commit: z.object({ oid: z.string() }).nullable(),
    state: z.enum(["APPROVED", "COMMENTED", "CHANGES_REQUESTED", "DISMISSED", "PENDING"]),
    submittedAt: z.string().nullable(),
    url: z.string(),
  })
  .transform((review): Review => ({
    author: review.author,
    authorAssociation: review.authorAssociation,
    body: review.body,
    commit: review.commit?.oid ?? null,
    state: review.state,
    submittedAt: review.submittedAt,
    url: review.url,
  }));

const statusStates = {
  ERROR: "error",
  EXPECTED: "expected",
  FAILURE: "failure",
  PENDING: "pending",
  SUCCESS: "success",
} as const;

const checkSchema = z.union([
  z
    .object({
      [typename]: z.literal("CheckRun"),
      completedAt: z.string().nullable(),
      conclusion: z.string().nullable(),
      name: z.string(),
      // Every status but COMPLETED, such as QUEUED and IN_PROGRESS, is not completed yet.
      status: z.string(),
    })
    .transform((run): Check => ({
      completedAt: run.completedAt,
      conclusion: run.conclusion?.toLowerCase() ?? null,
      kind: "checkRun",
      name: run.name,
      status: run.status === "COMPLETED" ? "completed" : "pending",
    })),
  z
    .object({
      [typename]: z.literal("StatusContext"),
      context: z.string(),
      createdAt: z.string(),
      state: z.enum(["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"]),
    })
    .transform((status): Check => ({
      createdAt: status.createdAt,
      kind: "status",
      name: status.context,
      state: statusStates[status.state],
    })),
]);

/** A page of checks, with the cursor of the next page when there is one. */
const contextsSchema = z
  .object({
    nodes: z.array(checkSchema.nullable()),
    pageInfo: z.object({ endCursor: z.string().nullable(), hasNextPage: z.boolean() }),
  })
  .transform(({ nodes, pageInfo }) => ({
    checks: nodes.filter((check): check is Check => check !== null),
    nextCursor: pageInfo.hasNextPage ? pageInfo.endCursor : null,
  }));

type ChecksPage = z.output<typeof contextsSchema>;

const noChecks: ChecksPage = { checks: [], nextCursor: null };

const pullRequestStates = { CLOSED: "closed", MERGED: "merged", OPEN: "open" } as const;

const pullRequestSchema = z
  .object({
    closedAt: z.string().nullable(),
    commits: nodesOf(
      z.object({
        commit: z.object({
          oid: z.string(),
          statusCheckRollup: z.object({ contexts: contextsSchema }).nullable(),
        }),
      }),
    ),
    headRefOid: z.string(),
    mergedAt: z.string().nullable(),
    number: z.int(),
    reviews: nodesOf(reviewSchema),
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    url: z.string(),
  })
  .transform((pullRequest): { snapshot: PullRequestSnapshot; nextChecksCursor: string | null } => {
    const [head] = pullRequest.commits;
    // A push between the reads of the head and of its commit gives checks of another commit.
    // They are left out until the next check reads them again.
    const { checks, nextCursor } =
      head?.commit.oid === pullRequest.headRefOid
        ? (head.commit.statusCheckRollup?.contexts ?? noChecks)
        : noChecks;
    return {
      nextChecksCursor: nextCursor,
      snapshot: {
        checks,
        closedAt: pullRequest.closedAt,
        headSha: pullRequest.headRefOid,
        mergedAt: pullRequest.mergedAt,
        number: pullRequest.number,
        reviews: pullRequest.reviews,
        state: pullRequestStates[pullRequest.state],
        url: pullRequest.url,
      },
    };
  });

const graphqlErrorsSchema = z.array(
  z.object({ message: z.string().optional(), type: z.string().optional() }),
);

const outputSchema = z.object({
  data: z
    .object({
      repository: z.object({ pullRequest: pullRequestSchema.nullable() }).nullable(),
    })
    .nullable()
    .optional(),
  errors: graphqlErrorsSchema.optional(),
});

const checksPageOutputSchema = z.object({
  data: z
    .object({
      repository: z
        .object({
          // The object is null when the commit does not exist, such as after a force push.
          object: z
            .object({ statusCheckRollup: z.object({ contexts: contextsSchema }).nullish() })
            .nullable(),
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  errors: graphqlErrorsSchema.optional(),
});

/** The part of an output that tells errors, read even when the rest has another shape. */
const errorsOutputSchema = z.object({ errors: graphqlErrorsSchema });

type GraphqlError = z.output<typeof graphqlErrorsSchema>[number];

const rateLimitSchema = z.object({
  resources: z.object({
    graphql: z.object({ remaining: z.number(), reset: z.number() }),
  }),
});

/** Longest part of the standard error of gh that a message includes. */
const maxStderrLength = 1000;

const trimStderr = (stderr: string): string => stderr.trim().slice(0, maxStderrLength);

const describeIssues = (error: z.ZodError): string =>
  error.issues
    .slice(0, 3)
    .map((issue) =>
      issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`,
    )
    .join("; ");

const unreadableOutput = (reason: string, cause?: unknown): GithubSourceError =>
  new GithubSourceError("fatal", `Could not read the output of gh: ${reason}`, { cause });

const parseJson = (text: string): { ok: true; value: unknown } | { ok: false; error: Error } => {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)), ok: false };
  }
};

/** Errors of GraphQL in an output, or none when the output does not tell them. */
const graphqlErrorsOf = (stdout: string): readonly GraphqlError[] => {
  const json = parseJson(stdout);
  if (!json.ok) {
    return [];
  }
  const output = errorsOutputSchema.safeParse(json.value);
  return output.success ? output.data.errors : [];
};

const formatTarget = (target: PullRequestTarget): string =>
  `${target.owner}/${target.name}#${target.number}`;

const notLoggedInMessage =
  "gh is not logged in to github.com, or its login is no longer valid. Run gh auth login as the " +
  "user who runs the Worker";

const rateLimitedMessage = "The rate limit of GitHub is reached";

const notFoundTypes: ReadonlySet<string> = new Set(["NOT_FOUND", "FORBIDDEN"]);

/** Fragments of the standard error of gh that tell problems of the network or of GitHub. */
const transientPatterns: readonly RegExp[] = [
  /HTTP 5\d\d/u,
  /error connecting to/u,
  /dial tcp/u,
  /i\/o timeout/u,
  /connection reset/u,
  /TLS handshake/u,
  /no such host/u,
  /EOF/u,
];

/** Whether GitHub told an error that {@link classifyFailure} tells apart by its type. */
const isKnownError = (error: GraphqlError): boolean =>
  error.type === "RATE_LIMITED" || (error.type !== undefined && notFoundTypes.has(error.type));

/** What a failed run of gh tells, before the time of a rate limit is read. */
type Failure = { kind: "rateLimited" } | { kind: "error"; error: GithubSourceError };

/** Tells the problem of a run of gh that failed, or of an output without the pull request. */
const classifyFailure = (target: PullRequestTarget, result: GhResult): Failure => {
  const stderr = trimStderr(result.stderr);
  const errors = graphqlErrorsOf(result.stdout);

  if (result.exitCode === 4 || stderr.includes("gh auth login") || stderr.includes("HTTP 401")) {
    return { error: new GithubSourceError("fatal", notLoggedInMessage), kind: "error" };
  }
  if (errors.some((error) => error.type === "RATE_LIMITED") || /rate limit/iu.test(stderr)) {
    return { kind: "rateLimited" };
  }
  const notFound = errors.find(
    (error) => error.type !== undefined && notFoundTypes.has(error.type),
  );
  if (notFound !== undefined) {
    const message = notFound.message ?? notFound.type ?? "";
    return {
      error: new GithubSourceError(
        "fatal",
        `Pull request ${formatTarget(target)} was not found, or gh cannot read it: ${message}`,
      ),
      kind: "error",
    };
  }
  if (transientPatterns.some((pattern) => pattern.test(stderr))) {
    const [firstLine = ""] = stderr.split("\n");
    return {
      error: new GithubSourceError("transient", `Could not reach GitHub: ${firstLine.trim()}`),
      kind: "error",
    };
  }
  const detail = stderr === "" ? "" : `: ${stderr}`;
  return {
    error: new GithubSourceError("fatal", `gh failed with exit code ${result.exitCode}${detail}`),
    kind: "error",
  };
};

/**
 * Reads when the GraphQL rate limit resets, or `undefined` when it cannot be read or is not
 * reached, such as for a secondary rate limit.
 *
 * @throws The reason of the signal when it is aborted.
 */
const readRateLimitReset = async (
  run: GhRunner,
  signal: AbortSignal,
): Promise<Date | undefined> => {
  let result: GhResult;
  try {
    result = await run(rateLimitArgs, signal);
  } catch {
    if (signal.aborted) {
      throw signal.reason;
    }
    // Without the time of the reset, the caller waits as for a transient error.
    return undefined;
  }
  if (result.exitCode !== 0) {
    return undefined;
  }
  const json = parseJson(result.stdout);
  const rateLimit = json.ok ? rateLimitSchema.safeParse(json.value) : undefined;
  if (rateLimit?.success !== true) {
    return undefined;
  }
  const { remaining, reset } = rateLimit.data.resources.graphql;
  // Points remain when a secondary rate limit is reached, and the reset of the primary rate limit
  // does not tell when it goes away.
  if (remaining > 0) {
    return undefined;
  }
  const resetAt = new Date(reset * 1000);
  return Number.isNaN(resetAt.getTime()) ? undefined : resetAt;
};

/** Turns a failure into the error to throw. */
const failureError = async (
  failure: Failure,
  run: GhRunner,
  signal: AbortSignal,
): Promise<GithubSourceError> => {
  if (failure.kind === "error") {
    return failure.error;
  }
  const resetAt = await readRateLimitReset(run, signal);
  return new GithubSourceError("rateLimited", rateLimitedMessage, { resetAt });
};

/** Options of {@link createGhSource}. */
export interface GhSourceOptions {
  /** Runs gh. Defaults to {@link runGh}. */
  run?: GhRunner | undefined;
}

/**
 * Creates a {@link PullRequestSource} that reads pull requests with `gh api graphql`.
 *
 * gh uses its own login, such as of `gh auth login` by the user who runs the Worker.
 */
export const createGhSource = ({ run = runGh }: GhSourceOptions = {}): PullRequestSource => {
  /**
   * Runs a query with gh and reads its output with a schema.
   *
   * @throws GithubSourceError when gh fails or the output has another shape.
   */
  const query = async <T extends z.ZodType>(
    target: PullRequestTarget,
    args: readonly string[],
    schema: T,
    signal: AbortSignal,
  ): Promise<{ output: z.output<T>; result: GhResult }> => {
    const result = await run(args, signal);
    if (result.exitCode !== 0) {
      throw await failureError(classifyFailure(target, result), run, signal);
    }
    const json = parseJson(result.stdout);
    if (!json.ok) {
      throw unreadableOutput(json.error.message, json.error);
    }
    const output = schema.safeParse(json.value);
    if (!output.success) {
      throw unreadableOutput(describeIssues(output.error), output.error);
    }
    return { output: output.data, result };
  };

  /**
   * Tells errors of GraphQL in an output that gh exited with 0 for. gh exits with 1 for errors of
   * GraphQL, so they are not expected. They are told in the same way as when gh fails, unless
   * they are of an unknown kind. Without errors, `undefined` is returned.
   */
  const errorsError = async (
    target: PullRequestTarget,
    result: GhResult,
    errors: readonly GraphqlError[],
    signal: AbortSignal,
  ): Promise<GithubSourceError | undefined> => {
    if (errors.some(isKnownError)) {
      return failureError(classifyFailure(target, result), run, signal);
    }
    const messages = errors.map((error) => error.message ?? error.type ?? "").join("; ");
    return messages === "" ? undefined : unreadableOutput(`GitHub returned ${messages}`);
  };

  /**
   * Reads the checks of a commit after the first page.
   *
   * @returns The checks, or `undefined` when the commit has gone, such as after a force push.
   */
  const readRestOfChecks = async (
    target: PullRequestTarget,
    oid: string,
    firstCursor: string,
    signal: AbortSignal,
  ): Promise<Check[] | undefined> => {
    const checks: Check[] = [];
    let cursor: string | null = firstCursor;
    while (cursor !== null) {
      const args: string[] = checksPageArgs(target, oid, cursor);
      const { output, result } = await query(target, args, checksPageOutputSchema, signal);
      const object = output.data?.repository?.object;
      if (object === null || object === undefined) {
        const error = await errorsError(target, result, output.errors ?? [], signal);
        if (error !== undefined) {
          throw error;
        }
        return undefined;
      }
      const page: ChecksPage = object.statusCheckRollup?.contexts ?? noChecks;
      checks.push(...page.checks);
      cursor = page.nextCursor;
    }
    return checks;
  };

  return {
    read: async (target, signal) => {
      const { output, result } = await query(target, pullRequestArgs(target), outputSchema, signal);
      const pullRequest = output.data?.repository?.pullRequest;
      if (pullRequest === null || pullRequest === undefined) {
        throw (
          (await errorsError(target, result, output.errors ?? [], signal)) ??
          unreadableOutput("data.repository.pullRequest is missing")
        );
      }

      const { nextChecksCursor, snapshot } = pullRequest;
      if (nextChecksCursor === null) {
        return snapshot;
      }
      const rest = await readRestOfChecks(target, snapshot.headSha, nextChecksCursor, signal);
      // A commit that has gone was replaced by a push, and its checks are left out as when the
      // head moves while it is read.
      return { ...snapshot, checks: rest === undefined ? [] : [...snapshot.checks, ...rest] };
    },
  };
};
