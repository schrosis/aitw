import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AiTimeoutError, createAiRunner, createPluginRegistry } from "@ugoke/core";
import type { AiRequest } from "@ugoke/core";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claudeCodePlugin, createClaudeCodePlugin } from "./index.ts";
import type { ClaudeQuery } from "./index.ts";

type Message = ClaudeQuery extends (params: never) => AsyncIterable<infer Item> ? Item : never;

const success = (fields: object = {}): Message => ({
  is_error: false,
  result: "done",
  session_id: "session-1",
  subtype: "success",
  type: "result",
  ...fields,
});

const assistant = (content: object[], parent: string | null = null): Message => ({
  message: { content: content.map((block) => ({ type: "text", ...block })) },
  parent_tool_use_id: parent,
  type: "assistant",
});

/** The message that Claude Code sends first, with the agents that the session can use. */
const init = (agents?: string[]): Message => ({
  apiKeySource: "none",
  claude_code_version: "1.0.0",
  cwd: "/repository",
  mcp_servers: [],
  model: "claude-opus-5-5",
  output_style: "default",
  permissionMode: "dontAsk",
  plugins: [],
  session_id: "session-1",
  skills: [],
  slash_commands: [],
  subtype: "init",
  tools: [],
  type: "system",
  uuid: "00000000-0000-0000-0000-000000000000",
  ...(agents === undefined ? {} : { agents }),
});

const request = (fields: Partial<AiRequest> = {}): AiRequest => ({
  options: {},
  prompt: "Review",
  provider: "claude-code",
  timeoutMs: 10_000,
  ...fields,
});

/** A query that waits until it is aborted, as a running step does. */
const untilAborted: ClaudeQuery = async function* query({ options }) {
  await new Promise((_resolve, reject) => {
    options.abortController?.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  yield success();
};

describe("claude-code provider", () => {
  let cwd: string;
  let seen: { options: Options; prompt: string }[];

  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "ugoke-claude-")));
    seen = [];
  });

  afterEach(() => {
    rmSync(cwd, { force: true, recursive: true });
  });

  const runner = (messages: Message[]) =>
    createAiRunner({
      cwd,
      plugins: createPluginRegistry({
        builtins: [
          createClaudeCodePlugin({
            query: async function* query(params) {
              seen.push(params);
              yield* messages;
            },
          }),
        ],
      }),
    });

  const signal = new AbortController().signal;

  it("registers the provider with the name that definitions use", () => {
    const registry = createPluginRegistry({ builtins: [claudeCodePlugin] });

    expect(registry.aiProviderNames()).toEqual(["claude-code"]);
  });

  it("returns text and the session without a schema", async () => {
    await expect(runner([success()]).run(request(), { signal })).resolves.toEqual({
      data: "done",
      sessionId: "session-1",
    });
  });

  it("returns the structured output with a schema", async () => {
    const schema = { type: "object" };

    await expect(
      runner([success({ structured_output: { verdict: "approve" } })]).run(request({ schema }), {
        signal,
      }),
    ).resolves.toEqual({ data: { verdict: "approve" }, sessionId: "session-1" });
    expect(seen[0]?.options.outputFormat).toEqual({ schema, type: "json_schema" });
  });

  it("passes the settings of the step", async () => {
    await runner([success()]).run(
      request({
        model: "claude-opus-5-5",
        options: { agent: "reviewer", allowedTools: ["Read"], maxBudgetUsd: 2 },
        sessionId: "session-0",
      }),
      { signal },
    );

    expect(seen).toMatchObject([
      {
        options: {
          agent: "reviewer",
          allowedTools: ["Read"],
          cwd,
          maxBudgetUsd: 2,
          model: "claude-opus-5-5",
          permissionMode: "dontAsk",
          resume: "session-0",
        },
        prompt: "Review",
      },
    ]);
  });

  it("omits what the step does not set", async () => {
    await runner([success()]).run(request(), { signal });

    for (const option of [
      "agent",
      "allowedTools",
      "maxBudgetUsd",
      "model",
      "outputFormat",
      "resume",
      "systemPrompt",
    ]) {
      expect(seen[0]?.options).not.toHaveProperty(option);
    }
  });

  it("uses the system prompt of Claude Code with an agent, so that the prompt of the agent applies", async () => {
    await runner([init(["reviewer"]), success()]).run(request({ options: { agent: "reviewer" } }), {
      signal,
    });

    expect(seen[0]?.options.systemPrompt).toEqual({ preset: "claude_code", type: "preset" });
  });

  it("runs with an agent that Claude Code knows", async () => {
    await expect(
      runner([init(["general-purpose", "reviewer"]), success()]).run(
        request({ options: { agent: "reviewer" } }),
        { signal },
      ),
    ).resolves.toEqual({ data: "done", sessionId: "session-1" });
  });

  it("fails and stops Claude Code when it does not know the agent", async () => {
    await expect(
      runner([init(["general-purpose"]), success()]).run(
        request({ options: { agent: "missing" } }),
        { signal },
      ),
    ).rejects.toThrow("Claude Code agent not found: missing");
    expect(seen[0]?.options.abortController?.signal.aborted).toBe(true);
  });

  it("fails when Claude Code does not tell the agents", async () => {
    await expect(
      runner([init(), success()]).run(request({ options: { agent: "reviewer" } }), { signal }),
    ).rejects.toThrow("Claude Code agent not found: reviewer");
  });

  it("does not look at the agents without an agent", async () => {
    await expect(runner([init([]), success()]).run(request(), { signal })).resolves.toEqual({
      data: "done",
      sessionId: "session-1",
    });
  });

  it.each([[""], [1]])("rejects the agent %j", async (agent) => {
    await expect(
      runner([success()]).run(request({ options: { agent } }), { signal }),
    ).rejects.toThrow("Invalid options of AI provider claude-code: agent:");
    expect(seen).toEqual([]);
  });

  it("denies edits of the definition of the workflow", async () => {
    await runner([success()]).run(request(), { signal });

    expect(seen[0]?.options.disallowedTools).toEqual([`Edit(/${join(cwd, ".ugoke")}/**)`]);
  });

  it("sets the variables of the definition over the inherited ones, and dotenv under them", async () => {
    writeFileSync(join(cwd, ".env"), "FROM_DOTENV=dotenv\nHOME=from-dotenv\nSET=from-dotenv\n");

    await runner([success()]).run(request({ dotenv: ".env", env: { SET: "from-env" } }), {
      signal,
    });

    expect(seen[0]?.options.env).toMatchObject({
      FROM_DOTENV: "dotenv",
      HOME: process.env.HOME,
      SET: "from-env",
    });
  });

  it("fails without running when the dotenv file is missing", async () => {
    await expect(
      runner([success()]).run(request({ dotenv: "missing.env" }), { signal }),
    ).rejects.toThrow("Failed to read the dotenv file missing.env");
    expect(seen).toEqual([]);
  });

  it("reports what the AI says and does, one line each", async () => {
    const progress: string[] = [];
    await runner([
      assistant([
        { text: "\nFirst line\nSecond line" },
        { type: "thinking" },
        { input: { file_path: "a.ts" }, name: "Read", type: "tool_use" },
        { input: { todos: [] }, name: "TodoWrite", type: "tool_use" },
      ]),
      assistant([{ text: "From a subagent" }], "tool-1"),
      success(),
    ]).run(request(), { onProgress: (text) => progress.push(text), signal });

    expect(progress).toEqual(["First line\n", "Read: a.ts\n", "TodoWrite\n"]);
  });

  it("shortens a long line of progress", async () => {
    const progress: string[] = [];
    await runner([assistant([{ text: "x".repeat(300) }]), success()]).run(request(), {
      onProgress: (text) => progress.push(text),
      signal,
    });

    expect(progress).toEqual([`${"x".repeat(200)}…\n`]);
  });

  it("fails with the reasons of an error result", async () => {
    await expect(
      runner([
        {
          errors: ["first", "second"],
          is_error: true,
          session_id: "s",
          subtype: "error_during_execution",
          type: "result",
        },
      ]).run(request(), { signal }),
    ).rejects.toThrow("Claude Code failed: first; second");
  });

  it("fails when a result that looks successful is an error", async () => {
    await expect(
      runner([success({ is_error: true, result: "Not logged in" })]).run(request(), { signal }),
    ).rejects.toThrow("Claude Code failed: Not logged in");
  });

  it("fails when the AI finishes without the structured result of a schema", async () => {
    await expect(
      runner([success()]).run(request({ schema: { type: "object" } }), { signal }),
    ).rejects.toThrow("Claude Code finished without a structured result");
  });

  it("fails without a result", async () => {
    await expect(runner([]).run(request(), { signal })).rejects.toThrow(
      "Claude Code finished without a result",
    );
  });

  const hanging = () =>
    createAiRunner({
      cwd,
      plugins: createPluginRegistry({
        builtins: [createClaudeCodePlugin({ query: untilAborted })],
      }),
    });

  it("reports a timeout", async () => {
    await expect(hanging().run(request({ timeoutMs: 20 }), { signal })).rejects.toBeInstanceOf(
      AiTimeoutError,
    );
  });

  it("stops when it is aborted, with the reason of the signal", async () => {
    const controller = new AbortController();
    const result = hanging().run(request(), { signal: controller.signal });
    controller.abort(new Error("Cancelled"));

    await expect(result).rejects.toThrow("Cancelled");
  });

  it("does not start after it is aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Cancelled"));

    await expect(runner([success()]).run(request(), { signal: controller.signal })).rejects.toThrow(
      "Cancelled",
    );
    expect(seen).toEqual([]);
  });
});
