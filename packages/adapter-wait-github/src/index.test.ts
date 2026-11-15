import { createPluginRegistry } from "@ugoke/core";
import type { WaitMethod, WaitResponseContext } from "@ugoke/core";
import { describe, expect, it } from "vitest";

import githubPluginByDefault, {
  createGithubPlugin,
  githubConfigSchema,
  githubPlugin,
  githubPrAnswers,
  githubPrOptionsSchema,
  GithubSourceError,
} from "./index.ts";
import type {
  GithubConfig,
  GithubPluginOptions,
  GithubPrOptions,
  PullRequestSnapshot,
  PullRequestSource,
  PullRequestTarget,
} from "./index.ts";

const url = "https://github.com/acme/widgets/pull/12";
const startedAt = new Date("2026-11-14T03:04:05Z");

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

/** A source that returns or throws the results in order, and repeats the last one. */
const sourceOf = (
  results: readonly (PullRequestSnapshot | Error)[],
): PullRequestSource & { targets: PullRequestTarget[] } => {
  const targets: PullRequestTarget[] = [];
  return {
    read: async (target) => {
      const result = results[Math.min(targets.length, results.length - 1)];
      targets.push(target);
      if (result === undefined || result instanceof Error) {
        throw result ?? new Error("No result");
      }
      return result;
    },
    targets,
  };
};

/** Returns the `github_pr` method of a plugin, as a definition that names it looks it up. */
const lookUp = (options?: GithubPluginOptions): WaitMethod => {
  const plugin = options === undefined ? githubPlugin : createGithubPlugin(options);
  const method = createPluginRegistry({ builtins: [plugin] }).waitMethod("github_pr");
  if (method === undefined) {
    throw new Error("github_pr is not registered");
  }
  return method;
};

/** Applies the schema of `with`, as the Activity does before `respond`. */
const parseOptions = (value: unknown): GithubPrOptions => githubPrOptionsSchema.parse(value);

const defaultConfig = githubConfigSchema.parse({});

const contextOf = (
  options: GithubPrOptions,
  overrides: Partial<WaitResponseContext<GithubPrOptions, GithubConfig>> = {},
): WaitResponseContext<GithubPrOptions, GithubConfig> => ({
  answers: githubPrAnswers,
  config: defaultConfig,
  log: () => {},
  options,
  run: { inputs: {}, workflowId: "review-0" },
  signal: new AbortController().signal,
  startedAt,
  step: "wait_review",
  visit: 0,
  ...overrides,
});

/** Records the waits instead of waiting. */
const recordSleeps = (): { sleeps: number[]; sleep: GithubPluginOptions["sleep"] } => {
  const sleeps: number[] = [];
  return {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    sleeps,
  };
};

describe("githubPlugin", () => {
  it("is the default export, named github with its settings", () => {
    expect(githubPluginByDefault).toBe(githubPlugin);
    expect(githubPlugin.name).toBe("github");
    expect(githubPlugin.config).toBe(githubConfigSchema);
  });

  it("provides github_pr as a built-in plugin, answering in the Worker", () => {
    const method = lookUp();

    expect(method.name).toBe("github_pr");
    expect(method.respondIn).toBe("worker");
  });

  it("is named github/github_pr outside the built-in plugins", () => {
    const registry = createPluginRegistry({ plugins: [githubPlugin] });

    expect(registry.waitMethodNames()).toEqual(["github/github_pr"]);
  });

  it("declares the same answers whatever the options are", () => {
    const method = lookUp();
    const merged = parseOptions({ events: ["merged"], pr: url });
    const review = parseOptions({
      events: ["review", "checks"],
      pr: 12,
      repo: "acme/widgets",
      review: { authors: ["octocat"], states: ["APPROVED"] },
      checks: { names: ["test"] },
    });

    expect(method.answers?.(merged, defaultConfig)).toBe(githubPrAnswers);
    expect(method.answers?.(review, defaultConfig)).toBe(githubPrAnswers);
  });
});

describe("github_pr respond", () => {
  it("answers with the source when the event happens", async () => {
    const source = sourceOf([openSnapshot, openSnapshot, mergedSnapshot]);
    const { sleep, sleeps } = recordSleeps();
    const method = lookUp({ sleep, source });
    const config = githubConfigSchema.parse({ pollInterval: "1m" });

    const answers = await method.respond?.(
      contextOf(parseOptions({ events: ["merged"], pr: 12, repo: "acme/widgets" }), { config }),
    );

    expect(answers).toEqual({
      event: "merged",
      headSha: openSnapshot.headSha,
      number: 12,
      occurredAt: "2026-11-14T04:00:00Z",
      url,
    });
    expect(source.targets).toEqual(
      Array.from({ length: 3 }, () => ({ name: "widgets", number: 12, owner: "acme" })),
    );
    expect(sleeps).toEqual([60_000, 60_000]);
  });

  it("writes to the log that errors continue", async () => {
    const source = sourceOf([
      new GithubSourceError("transient", "Could not reach GitHub"),
      new GithubSourceError("transient", "Could not reach GitHub"),
      mergedSnapshot,
    ]);
    const { sleep } = recordSleeps();
    const method = lookUp({ sleep, source });
    const lines: string[] = [];

    await method.respond?.(
      contextOf(parseOptions({ events: ["merged"], pr: url }), {
        log: (message) => lines.push(message),
      }),
    );

    expect(lines).toEqual([
      expect.stringContaining("Failed to check pull request acme/widgets#12 (1 in a row)"),
      expect.stringContaining("Failed to check pull request acme/widgets#12 (2 in a row)"),
      "Checked pull request acme/widgets#12 again after 2 failures in a row",
    ]);
    expect(lines[0]).toContain("Could not reach GitHub");
  });

  it("fails when the pull request ends with an event that it does not wait for", async () => {
    const method = lookUp({ source: sourceOf([mergedSnapshot]) });

    await expect(
      method.respond?.(contextOf(parseOptions({ events: ["review"], pr: url }))),
    ).rejects.toThrow("was merged, but events does not include merged");
  });

  it.each([
    ["is missing", undefined],
    ["is not a date", "2026-11-14T03:04:05Z"],
    ["is an invalid date", new Date(Number.NaN)],
  ])("fails with the reason when startedAt %s", async (_case, value) => {
    const source = sourceOf([mergedSnapshot]);
    const method = lookUp({ source });
    // An older engine does not give startedAt.
    const context = { ...contextOf(parseOptions({ events: ["merged"], pr: url })) };
    Reflect.set(context, "startedAt", value);

    await expect(method.respond?.(context)).rejects.toThrow(
      "This wait method needs a newer ugoke that tells when the step started to wait",
    );
    expect(source.targets).toEqual([]);
  });
});
