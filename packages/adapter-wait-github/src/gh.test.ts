import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { GhResult, GhRunner } from "./gh.ts";
import { createGhSource, pullRequestArgs, pullRequestQuery, rateLimitArgs } from "./gh.ts";
import type { PullRequestTarget } from "./options.ts";
import type { PullRequestSnapshot } from "./source.ts";
import { GithubSourceError } from "./source.ts";

// Outputs of gh 2.103.3 for a pull request of the repository of ugoke, with the owner, the
// repository, the number, logins of people, bodies, IDs, and commits replaced.
const mergedOutput = readFileSync(
  new URL("testdata/merged-pull-request.json", import.meta.url),
  "utf8",
);

const target: PullRequestTarget = { name: "widgets", number: 12, owner: "acme" };
const url = "https://github.com/acme/widgets/pull/12";
const headSha = "b".repeat(40);
const earlierSha = "a".repeat(40);

const mergedSnapshot: PullRequestSnapshot = {
  checks: [
    {
      completedAt: "2026-11-15T08:58:37Z",
      conclusion: "success",
      kind: "checkRun",
      name: "check",
      status: "completed",
    },
    {
      completedAt: "2026-11-15T08:59:17Z",
      conclusion: "success",
      kind: "checkRun",
      name: "review",
      status: "completed",
    },
    {
      completedAt: "2026-11-15T08:59:25Z",
      conclusion: "success",
      kind: "checkRun",
      name: "report",
      status: "completed",
    },
    { createdAt: "2026-11-15T08:59:23Z", kind: "status", name: "Claude Review", state: "success" },
  ],
  closedAt: "2026-11-15T09:02:43Z",
  headSha,
  mergedAt: "2026-11-15T09:02:43Z",
  number: 12,
  reviews: [
    {
      author: "claude[bot]",
      body: "",
      commit: earlierSha,
      state: "COMMENTED",
      submittedAt: "2026-11-15T08:50:54Z",
      url: `${url}#pullrequestreview-1001`,
    },
    {
      author: "github-actions[bot]",
      body: "Review body 2.",
      commit: earlierSha,
      state: "APPROVED",
      submittedAt: "2026-11-15T08:51:13Z",
      url: `${url}#pullrequestreview-1002`,
    },
    {
      author: "octocat",
      body: "",
      commit: earlierSha,
      state: "COMMENTED",
      submittedAt: "2026-11-15T08:58:07Z",
      url: `${url}#pullrequestreview-1003`,
    },
    {
      author: "github-actions[bot]",
      body: "Review body 4.",
      commit: headSha,
      state: "APPROVED",
      submittedAt: "2026-11-15T08:59:23Z",
      url: `${url}#pullrequestreview-1004`,
    },
  ],
  state: "merged",
  url,
};

const outputSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.looseObject({
        commits: z.object({ nodes: z.array(z.object({ commit: z.looseObject({}) })) }),
        reviews: z.object({ nodes: z.array(z.looseObject({}).nullable()) }),
      }),
    }),
  }),
});

type PullRequestOutput = z.output<typeof outputSchema>["data"]["repository"]["pullRequest"];

/** Returns the output of the merged pull request with changes. */
const changedOutput = (change: (pullRequest: PullRequestOutput) => void): string => {
  const output = outputSchema.parse(JSON.parse(mergedOutput));
  change(output.data.repository.pullRequest);
  return JSON.stringify(output);
};

/** Returns a review of an output to change. */
const reviewOf = (pullRequest: PullRequestOutput, index: number): Record<string, unknown> => {
  const review = pullRequest.reviews.nodes[index];
  if (review === undefined || review === null) {
    throw new Error(`No review at ${index}`);
  }
  return review;
};

/** Returns the head commit of an output to change. */
const headOf = (pullRequest: PullRequestOutput): Record<string, unknown> => {
  const [head] = pullRequest.commits.nodes;
  if (head === undefined) {
    throw new Error("No head commit");
  }
  return head.commit;
};

const ok = (stdout: string): GhResult => ({ exitCode: 0, stderr: "", stdout });

const failed = (exitCode: number, stderr: string, stdout = ""): GhResult => ({
  exitCode,
  stderr,
  stdout,
});

/** The output when the rate limit of the GraphQL API is reached. */
const graphqlRateLimitedResult = (): GhResult =>
  failed(
    1,
    "gh: API rate limit already exceeded for user ID 1.\n",
    JSON.stringify({
      errors: [{ message: "API rate limit already exceeded for user ID 1.", type: "RATE_LIMITED" }],
    }),
  );

const rateLimitOutput = (remaining: number, reset: number): GhResult =>
  ok(
    JSON.stringify({
      rate: { limit: 5000, remaining: 4987, reset: 1_794_736_711, used: 13 },
      resources: {
        core: { limit: 5000, remaining: 4987, reset: 1_794_736_711, used: 13 },
        graphql: { limit: 5000, remaining, reset, used: 5000 - remaining },
      },
    }),
  );

type Reply = GhResult | Error;

/** A runner that replies to queries of pull requests and of the rate limit, and records calls. */
const runnerOf = (
  pullRequest: Reply,
  rateLimit: Reply | ((signal: AbortSignal) => Promise<GhResult>) = rateLimitOutput(4900, 0),
): GhRunner & { calls: (readonly string[])[] } => {
  const calls: (readonly string[])[] = [];
  const run = async (args: readonly string[], signal: AbortSignal): Promise<GhResult> => {
    calls.push(args);
    const reply = args[1] === "rate_limit" ? rateLimit : pullRequest;
    if (typeof reply === "function") {
      return reply(signal);
    }
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  };
  return Object.assign(run, { calls });
};

const read = (run: GhRunner, signal = new AbortController().signal): Promise<PullRequestSnapshot> =>
  createGhSource({ run }).read(target, signal);

/** Reads with a runner and returns the error that the read throws. */
const readError = async (run: GhRunner): Promise<GithubSourceError> => {
  const error: unknown = await read(run).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof GithubSourceError)) {
    throw new Error(`Expected a GithubSourceError, but got ${String(error)}`);
  }
  return error;
};

describe("pullRequestArgs", () => {
  it("passes the query and each variable as one argument", () => {
    expect(pullRequestArgs(target)).toEqual([
      "api",
      "graphql",
      "-f",
      `query=${pullRequestQuery}`,
      "-f",
      "owner=acme",
      "-f",
      "name=widgets",
      "-F",
      "number=12",
    ]);
  });

  it("keeps values with spaces and characters of shells in one argument", () => {
    const args = pullRequestArgs({ name: "widgets -F x=$(id); `id`", number: 3, owner: "a b" });

    expect(args).toHaveLength(10);
    expect(args[5]).toBe("owner=a b");
    expect(args[7]).toBe("name=widgets -F x=$(id); `id`");
  });
});

describe("createGhSource", () => {
  it("runs gh with the arguments of the pull request", async () => {
    const run = runnerOf(ok(mergedOutput));

    await read(run);

    expect(run.calls).toEqual([pullRequestArgs(target)]);
  });

  it("converts the output of gh to a snapshot", async () => {
    await expect(read(runnerOf(ok(mergedOutput)))).resolves.toEqual(mergedSnapshot);
  });

  it("reads a pull request that is open, with checks that are not completed", async () => {
    const stdout = changedOutput((pullRequest) => {
      Object.assign(pullRequest, { closedAt: null, mergedAt: null, state: "OPEN" });
      headOf(pullRequest)["statusCheckRollup"] = {
        contexts: {
          nodes: [
            {
              __typename: "CheckRun",
              completedAt: null,
              conclusion: null,
              name: "check",
              status: "IN_PROGRESS",
            },
            {
              __typename: "CheckRun",
              completedAt: null,
              conclusion: null,
              name: "review",
              status: "QUEUED",
            },
            {
              __typename: "CheckRun",
              completedAt: "2026-11-14T11:24:40Z",
              conclusion: "SKIPPED",
              name: "report",
              status: "COMPLETED",
            },
            {
              __typename: "StatusContext",
              context: "Claude Review",
              createdAt: "2026-11-14T11:30:37Z",
              state: "PENDING",
            },
            {
              __typename: "StatusContext",
              context: "deploy",
              createdAt: "2026-11-14T11:30:38Z",
              state: "EXPECTED",
            },
          ],
        },
      };
    });

    const snapshot = await read(runnerOf(ok(stdout)));

    expect(snapshot).toMatchObject({ closedAt: null, mergedAt: null, state: "open" });
    expect(snapshot.checks).toEqual([
      { completedAt: null, conclusion: null, kind: "checkRun", name: "check", status: "pending" },
      { completedAt: null, conclusion: null, kind: "checkRun", name: "review", status: "pending" },
      {
        completedAt: "2026-11-14T11:24:40Z",
        conclusion: "skipped",
        kind: "checkRun",
        name: "report",
        status: "completed",
      },
      {
        createdAt: "2026-11-14T11:30:37Z",
        kind: "status",
        name: "Claude Review",
        state: "pending",
      },
      { createdAt: "2026-11-14T11:30:38Z", kind: "status", name: "deploy", state: "expected" },
    ]);
  });

  it("reads a pull request that was closed without merging", async () => {
    const stdout = changedOutput((pullRequest) => {
      Object.assign(pullRequest, { mergedAt: null, state: "CLOSED" });
    });

    await expect(read(runnerOf(ok(stdout)))).resolves.toMatchObject({
      closedAt: "2026-11-15T09:02:43Z",
      mergedAt: null,
      state: "closed",
    });
  });

  it("names the author of a deleted account ghost", async () => {
    const stdout = changedOutput((pullRequest) => {
      reviewOf(pullRequest, 2)["author"] = null;
    });

    const snapshot = await read(runnerOf(ok(stdout)));

    expect(snapshot.reviews[2]?.author).toBe("ghost");
  });

  it("reads a pending review and a review without a commit", async () => {
    const stdout = changedOutput((pullRequest) => {
      Object.assign(reviewOf(pullRequest, 2), {
        commit: null,
        state: "PENDING",
        submittedAt: null,
      });
    });

    const snapshot = await read(runnerOf(ok(stdout)));

    expect(snapshot.reviews[2]).toMatchObject({
      commit: null,
      state: "PENDING",
      submittedAt: null,
    });
  });

  it("returns no checks when the head commit has none", async () => {
    const stdout = changedOutput((pullRequest) => {
      headOf(pullRequest)["statusCheckRollup"] = null;
    });

    const snapshot = await read(runnerOf(ok(stdout)));

    expect(snapshot.checks).toEqual([]);
    expect(snapshot.headSha).toBe(headSha);
  });

  it("returns no checks when the commit that was read is not the head", async () => {
    const stdout = changedOutput((pullRequest) => {
      pullRequest["headRefOid"] = "c".repeat(40);
    });

    const snapshot = await read(runnerOf(ok(stdout)));

    expect(snapshot.checks).toEqual([]);
    expect(snapshot.headSha).toBe("c".repeat(40));
  });

  it("skips items of lists that GitHub returns as null", async () => {
    const stdout = changedOutput((pullRequest) => {
      pullRequest.reviews.nodes.push(null);
    });

    const snapshot = await read(runnerOf(ok(stdout)));

    expect(snapshot.reviews).toHaveLength(4);
  });

  describe("outputs that cannot be read", () => {
    it.each([
      ["is not JSON", "Not Found", /^Could not read the output of gh: .+/u],
      [
        "has a field of another type",
        changedOutput((pullRequest) => {
          pullRequest["number"] = "12";
        }),
        /^Could not read the output of gh: data\.repository\.pullRequest\.number: .+/u,
      ],
      [
        "has an unknown state",
        changedOutput((pullRequest) => {
          pullRequest["state"] = "DRAFT";
        }),
        /^Could not read the output of gh: data\.repository\.pullRequest\.state: .+/u,
      ],
      [
        "has an unknown kind of check",
        changedOutput((pullRequest) => {
          headOf(pullRequest)["statusCheckRollup"] = {
            contexts: { nodes: [{ __typename: "Unknown" }] },
          };
        }),
        /^Could not read the output of gh: .+/u,
      ],
      [
        "has no pull request",
        JSON.stringify({ data: { repository: { pullRequest: null } } }),
        /^Could not read the output of gh: data\.repository\.pullRequest is missing$/u,
      ],
    ])("fails when the output %s", async (_, stdout, message) => {
      const error = await readError(runnerOf(ok(stdout)));

      expect(error.kind).toBe("fatal");
      expect(error.message).toMatch(message);
    });
  });

  describe("errors of gh", () => {
    // Outputs of gh 2.103.3 unless noted otherwise.
    const notLoggedIn = failed(
      4,
      "To get started with GitHub CLI, please run:  gh auth login\n" +
        "Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n",
    );
    const badCredentials = failed(
      1,
      "gh: Bad credentials (HTTP 401)\n",
      '{\n  "message": "Bad credentials",\n  "documentation_url": "https://docs.github.com/rest",\n  "status": "401"\n}',
    );
    // From the documentation of the GraphQL API, as the limit cannot be reached by hand.
    const graphqlRateLimited = failed(
      1,
      "gh: API rate limit already exceeded for user ID 1.\n",
      JSON.stringify({
        errors: [
          {
            code: "graphql_rate_limit",
            message: "API rate limit already exceeded for user ID 1.",
            type: "RATE_LIMITED",
          },
        ],
      }),
    );
    // From the documentation of the REST API.
    const secondaryRateLimited = failed(
      1,
      "gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)\n",
      JSON.stringify({
        documentation_url:
          "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits",
        message:
          "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
      }),
    );
    const noPullRequest = failed(
      1,
      "gh: Could not resolve to a PullRequest with the number of 12.\n",
      JSON.stringify({
        data: { repository: { pullRequest: null } },
        errors: [
          {
            locations: [{ column: 5, line: 3 }],
            message: "Could not resolve to a PullRequest with the number of 12.",
            path: ["repository", "pullRequest"],
            type: "NOT_FOUND",
          },
        ],
      }),
    );
    const noRepository = failed(
      1,
      "gh: Could not resolve to a Repository with the name 'acme/widgets'.\n",
      JSON.stringify({
        data: { repository: null },
        errors: [
          {
            locations: [{ column: 3, line: 2 }],
            message: "Could not resolve to a Repository with the name 'acme/widgets'.",
            path: ["repository"],
            type: "NOT_FOUND",
          },
        ],
      }),
    );
    // From the documentation of the GraphQL API, for a repository that a token cannot read.
    const forbidden = failed(
      1,
      "gh: Resource not accessible by integration\n",
      JSON.stringify({
        data: { repository: null },
        errors: [
          {
            message: "Resource not accessible by integration",
            path: ["repository"],
            type: "FORBIDDEN",
          },
        ],
      }),
    );
    const connectionRefused = failed(
      1,
      'Post "https://api.github.com/graphql": proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused\n',
    );
    const noHost = failed(
      1,
      "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n",
    );
    const unknownField = failed(
      1,
      "gh: Field 'nope' doesn't exist on type 'Query'\n",
      JSON.stringify({
        errors: [
          {
            extensions: { code: "undefinedField", fieldName: "nope", typeName: "Query" },
            locations: [{ column: 9, line: 1 }],
            message: "Field 'nope' doesn't exist on type 'Query'",
            path: ["query", "nope"],
          },
        ],
      }),
    );

    const notLoggedInMessage =
      "gh is not logged in to github.com, or its login is no longer valid. Run gh auth login as the user who runs the Worker";

    it.each([
      ["gh is not logged in", notLoggedIn],
      ["the login is no longer valid", badCredentials],
      ["the exit code is 4", failed(4, "")],
      ["a message tells gh auth login", failed(1, "gh: try authenticating with:  gh auth login\n")],
    ])("fails to log in when %s (row 1)", async (_, result) => {
      const error = await readError(runnerOf(result));

      expect(error.kind).toBe("fatal");
      expect(error.message).toBe(notLoggedInMessage);
    });

    it("tells no login before the other rows", async () => {
      const error = await readError(
        runnerOf(failed(4, "gh: API rate limit exceeded\n", noPullRequest.stdout)),
      );

      expect(error.message).toBe(notLoggedInMessage);
    });

    it.each([
      ["the GraphQL API tells RATE_LIMITED", graphqlRateLimited],
      ["a secondary rate limit is reached", secondaryRateLimited],
      ["the standard error tells a rate limit in any case", failed(1, "gh: Rate Limit exceeded\n")],
    ])("waits for the rate limit when %s (row 2)", async (_, result) => {
      const error = await readError(runnerOf(result));

      expect(error.kind).toBe("rateLimited");
      expect(error.message).toBe("The rate limit of GitHub is reached");
    });

    it("tells the rate limit before a pull request that was not found", async () => {
      const stdout = JSON.stringify({
        errors: [
          { message: "API rate limit exceeded", type: "RATE_LIMITED" },
          { message: "Could not resolve", type: "NOT_FOUND" },
        ],
      });

      const error = await readError(runnerOf(failed(1, "gh: API rate limit exceeded\n", stdout)));

      expect(error.kind).toBe("rateLimited");
    });

    it.each([
      [
        "the pull request does not exist",
        noPullRequest,
        "Could not resolve to a PullRequest with the number of 12.",
      ],
      [
        "the repository does not exist",
        noRepository,
        "Could not resolve to a Repository with the name 'acme/widgets'.",
      ],
      ["gh cannot read the repository", forbidden, "Resource not accessible by integration"],
    ])("fails when %s (row 3)", async (_, result, githubMessage) => {
      const error = await readError(runnerOf(result));

      expect(error.kind).toBe("fatal");
      expect(error.message).toBe(
        `Pull request acme/widgets#12 was not found, or gh cannot read it: ${githubMessage}`,
      );
    });

    it("tells a pull request that was not found when gh exits with 0", async () => {
      const error = await readError(runnerOf(ok(noPullRequest.stdout)));

      expect(error.kind).toBe("fatal");
      expect(error.message).toBe(
        "Pull request acme/widgets#12 was not found, or gh cannot read it: Could not resolve to a PullRequest with the number of 12.",
      );
    });

    it.each([
      [
        connectionRefused,
        'Post "https://api.github.com/graphql": proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused',
      ],
      [noHost, "error connecting to api.github.com"],
      [
        failed(1, "gh: HTTP 502: Bad Gateway (https://api.github.com/graphql)\n"),
        "gh: HTTP 502: Bad Gateway (https://api.github.com/graphql)",
      ],
      [failed(1, "gh: Server Error (HTTP 503)\n"), "gh: Server Error (HTTP 503)"],
      [
        failed(
          1,
          'Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host\n',
        ),
        'Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host',
      ],
      [
        failed(
          1,
          'Post "https://api.github.com/graphql": read tcp 10.0.0.2:50000->140.82.112.6:443: i/o timeout\n',
        ),
        'Post "https://api.github.com/graphql": read tcp 10.0.0.2:50000->140.82.112.6:443: i/o timeout',
      ],
      [
        failed(1, 'Post "https://api.github.com/graphql": read: connection reset by peer\n'),
        'Post "https://api.github.com/graphql": read: connection reset by peer',
      ],
      [
        failed(1, 'Post "https://api.github.com/graphql": net/http: TLS handshake timeout\n'),
        'Post "https://api.github.com/graphql": net/http: TLS handshake timeout',
      ],
      [
        failed(1, 'Post "https://api.github.com/graphql": unexpected EOF\n'),
        'Post "https://api.github.com/graphql": unexpected EOF',
      ],
    ])(
      "checks again later when GitHub cannot be reached (row 4): %j",
      async (result, firstLine) => {
        const error = await readError(runnerOf(result));

        expect(error.kind).toBe("transient");
        expect(error.message).toBe(`Could not reach GitHub: ${firstLine}`);
      },
    );

    it("does not take a client error for a server error", async () => {
      const error = await readError(runnerOf(failed(1, "gh: Validation Failed (HTTP 422)\n")));

      expect(error.kind).toBe("fatal");
    });

    it("fails with the standard error for other errors (row 5)", async () => {
      const error = await readError(runnerOf(unknownField));

      expect(error.kind).toBe("fatal");
      expect(error.message).toBe(
        "gh failed with exit code 1: gh: Field 'nope' doesn't exist on type 'Query'",
      );
    });

    it("fails without a standard error for other errors", async () => {
      const error = await readError(runnerOf(failed(2, "  \n")));

      expect(error.message).toBe("gh failed with exit code 2");
    });

    it("trims the standard error and keeps its first 1,000 characters", async () => {
      const stderr = `\n  gh: ${"x".repeat(2000)}\n`;

      const error = await readError(runnerOf(failed(1, stderr)));

      expect(error.message).toBe(`gh failed with exit code 1: gh: ${"x".repeat(996)}`);
    });

    it("fails with unknown errors of GraphQL when gh exits with 0", async () => {
      const error = await readError(runnerOf(ok(unknownField.stdout)));

      expect(error.kind).toBe("fatal");
      expect(error.message).toBe(
        "Could not read the output of gh: GitHub returned Field 'nope' doesn't exist on type 'Query'",
      );
    });
  });

  describe("the time when the rate limit resets", () => {
    const reset = 1_794_736_699;

    it("reads it with gh api rate_limit", async () => {
      const run = runnerOf(graphqlRateLimitedResult(), rateLimitOutput(0, reset));

      const error = await readError(run);

      expect(run.calls).toEqual([pullRequestArgs(target), rateLimitArgs]);
      expect(rateLimitArgs).toEqual(["api", "rate_limit"]);
      expect(error.kind).toBe("rateLimited");
      expect(error.resetAt).toEqual(new Date(reset * 1000));
    });

    it("leaves it out while points of the GraphQL API remain", async () => {
      const error = await readError(
        runnerOf(graphqlRateLimitedResult(), rateLimitOutput(1, reset)),
      );

      expect(error.kind).toBe("rateLimited");
      expect(error.resetAt).toBeUndefined();
    });

    it.each([
      ["gh fails", failed(1, "gh: Server Error (HTTP 500)\n")],
      ["the output is not JSON", ok("{")],
      ["the output has another shape", ok(JSON.stringify({ resources: { core: {} } }))],
      ["gh cannot run", new GithubSourceError("transient", "Could not reach GitHub: timeout")],
    ])("leaves it out when %s", async (_, rateLimit) => {
      const error = await readError(runnerOf(graphqlRateLimitedResult(), rateLimit));

      expect(error.kind).toBe("rateLimited");
      expect(error.resetAt).toBeUndefined();
    });

    it("throws the reason of the signal when it is aborted while reading it", async () => {
      const controller = new AbortController();
      const reason = new Error("cancelled");
      const run = runnerOf(graphqlRateLimitedResult(), async () => {
        controller.abort(reason);
        throw reason;
      });

      await expect(read(run, controller.signal)).rejects.toBe(reason);
    });
  });

  it("throws what the runner throws, such as the reason of the signal", async () => {
    const reason = new Error("cancelled");

    await expect(read(runnerOf(reason))).rejects.toBe(reason);
  });
});
