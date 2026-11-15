import { toJsonSchema, validateWithSchema } from "@ugoke/core";
import { describe, expect, it } from "vitest";

import { githubConfigSchema, githubPrOptionsSchema, resolveTarget } from "./options.ts";
import type { GithubPrOptions } from "./options.ts";

const url = "https://github.com/acme/widgets/pull/12";

const validate = (options: unknown) => validateWithSchema(githubPrOptionsSchema, options);

const errorsOf = (options: unknown) => {
  const result = validate(options);
  return result.ok ? [] : result.errors;
};

describe("githubPrOptionsSchema", () => {
  it.each([
    ["a URL", { events: ["review"], pr: url }],
    ["a URL that ends with /", { events: ["review"], pr: `${url}/` }],
    ["a number", { events: ["review"], pr: 12, repo: "acme/widgets" }],
    ["a string of digits", { events: ["review"], pr: "12", repo: "acme/widgets" }],
    ["a repository with dots and underscores", { events: ["merged"], pr: 1, repo: "a-b/c.d_e" }],
  ])("accepts %s", (_label, options) => {
    expect(validate(options)).toEqual({ ok: true, value: options });
  });

  it("accepts every field", () => {
    const options = {
      checks: { names: ["test", "Claude Review"] },
      events: ["review", "merged", "closed", "checks"],
      message: "Waiting for the review",
      pr: url,
      review: { authors: ["claude[bot]"], states: ["APPROVED", "CHANGES_REQUESTED"] },
    };

    expect(validate(options)).toEqual({ ok: true, value: options });
  });

  const prMessage =
    "Must be a pull request URL such as https://github.com/owner/repo/pull/1, or its number";

  it.each([
    ["a host other than github.com", "https://github.example.com/acme/widgets/pull/12"],
    ["a URL that ends with /files", `${url}/files`],
    ["the URL of an issue", "https://github.com/acme/widgets/issues/12"],
    ["http", "http://github.com/acme/widgets/pull/12"],
    ["the number 0", "0"],
    ["a number with a leading zero", "012"],
    ["a number with spaces", " 12"],
    ["a URL with a trailing newline", `${url}\n`],
  ])("rejects a pr of %s", (_label, pr) => {
    expect(errorsOf({ events: ["review"], pr, repo: "acme/widgets" })).toContainEqual({
      message: prMessage,
      path: ["pr"],
    });
  });

  it("does not ask for repo when pr is invalid", () => {
    expect(errorsOf({ events: ["review"], pr: "twelve" })).toEqual([
      { message: prMessage, path: ["pr"] },
    ]);
  });

  it.each([[0], [-1], [1.5]])("rejects a pr of the number %s", (pr) => {
    const result = validate({ events: ["review"], pr, repo: "acme/widgets" });

    expect(result.ok).toBe(false);
  });

  it.each([["acme"], ["acme/widgets/extra"], ["acme/wid gets"], ["https://github.com/acme/x"]])(
    "rejects a repo of %s",
    (repo) => {
      expect(errorsOf({ events: ["review"], pr: 12, repo })).toEqual([
        { message: "Must be owner/repo", path: ["repo"] },
      ]);
    },
  );

  it.each([[12], ["12"]])("requires repo when pr is the number %j", (pr) => {
    expect(errorsOf({ events: ["review"], pr })).toEqual([
      { message: "Required when pr is a number", path: ["repo"] },
    ]);
  });

  it("rejects repo when pr is a URL", () => {
    expect(errorsOf({ events: ["review"], pr: url, repo: "acme/widgets" })).toEqual([
      { message: "Cannot be used when pr is a URL", path: ["repo"] },
    ]);
  });

  it("rejects duplicate events at each repetition", () => {
    expect(errorsOf({ events: ["review", "merged", "review", "review"], pr: url })).toEqual([
      { message: "Duplicate event: review", path: ["events", 2] },
      { message: "Duplicate event: review", path: ["events", 3] },
    ]);
  });

  it("rejects duplicate review states", () => {
    const options = {
      events: ["review"],
      pr: url,
      review: { states: ["APPROVED", "COMMENTED", "APPROVED"] },
    };

    expect(errorsOf(options)).toEqual([
      { message: "Duplicate state: APPROVED", path: ["review", "states", 2] },
    ]);
  });

  it("rejects review when events does not include review", () => {
    const options = { events: ["merged"], pr: url, review: { states: ["APPROVED"] } };

    expect(errorsOf(options)).toEqual([
      { message: "Can be used only when events includes review", path: ["review"] },
    ]);
  });

  it("rejects checks when events does not include checks", () => {
    const options = { checks: { names: ["test"] }, events: ["review"], pr: url };

    expect(errorsOf(options)).toEqual([
      { message: "Can be used only when events includes checks", path: ["checks"] },
    ]);
  });

  it("requires checks when events includes checks", () => {
    expect(errorsOf({ events: ["checks"], pr: url })).toEqual([
      { message: "Required when events includes checks", path: ["checks"] },
    ]);
  });

  it("reports every error at once", () => {
    const options = {
      events: ["merged", "merged"],
      pr: url,
      repo: "acme",
      review: {},
    };

    expect(errorsOf(options)).toEqual([
      { message: "Must be owner/repo", path: ["repo"] },
      { message: "Cannot be used when pr is a URL", path: ["repo"] },
      { message: "Duplicate event: merged", path: ["events", 1] },
      { message: "Can be used only when events includes review", path: ["review"] },
    ]);
  });

  it.each([
    ["without repo", { events: ["review"], pr: "${{ outputs.pr }}" }],
    ["with repo", { events: ["review"], pr: "${{ outputs.pr }}", repo: "acme/widgets" }],
    ["inside a URL", { events: ["review"], pr: "https://github.com/acme/widgets/pull/${{ n }}" }],
  ])("skips the checks of a pr with an expression %s", (_label, options) => {
    expect(validate(options)).toEqual({ ok: true, value: options });
  });

  it("skips the form of a repo with an expression, but still requires it", () => {
    expect(validate({ events: ["review"], pr: 12, repo: "${{ inputs.repo }}" }).ok).toBe(true);
    expect(validate({ events: ["review"], pr: 12, repo: "acme/${{ inputs.name }}" }).ok).toBe(true);
    expect(errorsOf({ events: ["review"], pr: url, repo: "${{ inputs.repo }}" })).toEqual([
      { message: "Cannot be used when pr is a URL", path: ["repo"] },
    ]);
  });

  it("accepts expressions in review.authors and checks.names", () => {
    const options = {
      checks: { names: ["${{ inputs.check }}"] },
      events: ["review", "checks"],
      pr: url,
      review: { authors: ["${{ inputs.reviewer }}"] },
    };

    expect(validate(options)).toEqual({ ok: true, value: options });
  });

  it("rejects an expression in events and review.states", () => {
    const events = errorsOf({ events: ["${{ inputs.event }}"], pr: url });
    const states = errorsOf({
      events: ["review"],
      pr: url,
      review: { states: ["${{ inputs.state }}"] },
    });

    expect(events.map(({ path }) => path)).toEqual([["events", 0]]);
    expect(states.map(({ path }) => path)).toEqual([["review", "states", 0]]);
  });

  it.each([
    ["no events", { events: [], pr: url }],
    ["an unknown event", { events: ["commented"], pr: url }],
    ["an unknown field", { events: ["review"], pr: url, branch: "main" }],
    ["an unknown field of review", { events: ["review"], pr: url, review: { users: ["a"] } }],
    ["no names of checks", { checks: { names: [] }, events: ["checks"], pr: url }],
    ["an empty message", { events: ["review"], message: "", pr: url }],
    ["no pr", { events: ["review"] }],
  ])("rejects %s", (_label, options) => {
    expect(validate(options).ok).toBe(false);
  });

  it("converts to JSON Schema", () => {
    const schema = toJsonSchema(githubPrOptionsSchema);

    expect(schema).toMatchObject({
      additionalProperties: false,
      properties: {
        events: { items: { enum: ["merged", "closed", "checks", "review"] }, type: "array" },
        pr: { description: expect.any(String) },
      },
      required: ["pr", "events"],
      type: "object",
    });
  });
});

describe("resolveTarget", () => {
  const options = (value: Partial<GithubPrOptions>): GithubPrOptions => ({
    events: ["review"],
    pr: url,
    ...value,
  });

  it.each([
    ["a URL", options({}), { name: "widgets", number: 12, owner: "acme" }],
    [
      "a URL that ends with /",
      options({ pr: `${url}/` }),
      { name: "widgets", number: 12, owner: "acme" },
    ],
    [
      "a number",
      options({ pr: 7, repo: "acme/a.b_c" }),
      { name: "a.b_c", number: 7, owner: "acme" },
    ],
    [
      "a string of digits",
      options({ pr: "7", repo: "acme/x" }),
      { name: "x", number: 7, owner: "acme" },
    ],
  ])("returns the pull request of %s", (_label, value, target) => {
    expect(resolveTarget(value)).toEqual(target);
  });

  it("throws when pr is still an expression", () => {
    expect(() => resolveTarget(options({ pr: "${{ outputs.pr }}" }))).toThrow(
      "pr: Must be a pull request URL such as https://github.com/owner/repo/pull/1, or its number",
    );
  });

  it("throws when repo is still an expression", () => {
    expect(() => resolveTarget(options({ pr: 7, repo: "${{ inputs.repo }}" }))).toThrow(
      "repo: Must be owner/repo",
    );
  });

  it("throws when repo is missing for a number", () => {
    expect(() => resolveTarget(options({ pr: 7 }))).toThrow("repo: Required when pr is a number");
  });
});

describe("githubConfigSchema", () => {
  it("defaults pollInterval to 30 seconds", () => {
    expect(validateWithSchema(githubConfigSchema, {})).toEqual({
      ok: true,
      value: { pollInterval: 30_000 },
    });
  });

  it.each([
    ["10s", 10_000],
    ["1m", 60_000],
    ["1h", 3_600_000],
  ])("converts a pollInterval of %s to milliseconds", (pollInterval, ms) => {
    expect(validateWithSchema(githubConfigSchema, { pollInterval })).toEqual({
      ok: true,
      value: { pollInterval: ms },
    });
  });

  it("rejects a pollInterval shorter than 10 seconds", () => {
    expect(validateWithSchema(githubConfigSchema, { pollInterval: "9s" })).toEqual({
      errors: [{ message: "Must be 10s or longer", path: ["pollInterval"] }],
      ok: false,
    });
  });

  it.each([["1d"], ["0s"], ["1.5m"]])("rejects a pollInterval of %s", (pollInterval) => {
    expect(validateWithSchema(githubConfigSchema, { pollInterval })).toEqual({
      errors: [
        { message: "Must be a positive duration such as 30s, 5m, or 1h", path: ["pollInterval"] },
      ],
      ok: false,
    });
  });

  it("rejects a pollInterval of a number", () => {
    const result = validateWithSchema(githubConfigSchema, { pollInterval: 10 });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.map(({ path }) => path)).toEqual([["pollInterval"]]);
  });

  it("rejects unknown fields", () => {
    expect(validateWithSchema(githubConfigSchema, { token: "secret" }).ok).toBe(false);
  });

  it("converts to JSON Schema", () => {
    expect(toJsonSchema(githubConfigSchema)).toMatchObject({
      additionalProperties: false,
      properties: {
        pollInterval: { default: "30s", description: expect.any(String), type: "string" },
      },
      type: "object",
    });
  });
});
