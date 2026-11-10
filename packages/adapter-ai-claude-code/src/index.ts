import { join } from "node:path";

import { AiTimeoutError, defineAiProvider, definePlugin } from "@aitw/core";
import type { AiProvider, AiResult, Plugin } from "@aitw/core";
import { readEnvironment } from "@aitw/dotenv";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/** Options of the `with` field of a step. */
const optionsSchema = z.strictObject({
  allowedTools: z.array(z.string().min(1)).optional(),
  maxBudgetUsd: z.number().positive().optional(),
});

/** A block of what the AI said or did. */
interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

/** The fields of the messages of the SDK that the provider reads. */
type ClaudeMessage =
  | {
      type: "assistant";
      parent_tool_use_id: string | null;
      message: { content: readonly ContentBlock[] };
    }
  | {
      type: "result";
      subtype: string;
      is_error: boolean;
      session_id: string;
      result?: string;
      structured_output?: unknown;
      errors?: readonly string[];
    }
  | Exclude<SDKMessage, { type: "assistant" | "result" }>;

/** Runs a prompt with the Claude Agent SDK. */
export type ClaudeQuery = (params: {
  prompt: string;
  options: Options;
}) => AsyncIterable<ClaudeMessage>;

/** The SDK is loaded when a step runs, so that other commands of aitw start quickly. */
const sdkQuery: ClaudeQuery = async function* sdkQuery(params) {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  yield* query(params);
};

/** Longest summary of what the AI says or does, in characters. */
const maxSummaryLength = 200;

/** Fields of the input of a tool that tell what it works on, from the most telling. */
const toolDetailFields = ["command", "file_path", "path", "pattern", "url", "query", "description"];

/** Returns the first line of a text with content, shortened to fit a line of progress. */
const summarize = (text: string): string => {
  const line =
    text
      .split(/\r?\n/u)
      .find((candidate) => candidate.trim() !== "")
      ?.trim() ?? "";
  return line.length > maxSummaryLength ? `${line.slice(0, maxSummaryLength)}…` : line;
};

const describeTool = ({ input, name = "tool" }: ContentBlock): string => {
  if (typeof input !== "object" || input === null) {
    return name;
  }
  const details = new Map(Object.entries(input));
  const detail = toolDetailFields
    .map((field) => details.get(field))
    .find((value) => typeof value === "string");
  return typeof detail === "string" ? `${name}: ${summarize(detail)}` : name;
};

/** Returns the lines of progress of a block, each ending with a newline. */
const describeBlock = (block: ContentBlock): string | undefined => {
  if (block.type === "text" && block.text !== undefined && block.text.trim() !== "") {
    return `${summarize(block.text)}\n`;
  }
  return block.type === "tool_use" ? `${describeTool(block)}\n` : undefined;
};

const describeFailure = (message: Extract<ClaudeMessage, { type: "result" }>): string => {
  const reasons = message.errors?.join("; ") || message.result || message.subtype;
  return `Claude Code failed: ${reasons}`;
};

/** Options of {@link createClaudeCodePlugin}. */
export interface ClaudeCodePluginOptions {
  /** Runs the prompt. Defaults to the Claude Agent SDK. */
  query?: ClaudeQuery;
}

const createProvider = (query: ClaudeQuery): AiProvider<z.output<typeof optionsSchema>> =>
  defineAiProvider({
    name: "claude-code",
    run: async (
      {
        cwd,
        dotenv,
        env,
        model,
        options: { allowedTools, maxBudgetUsd },
        prompt,
        schema,
        sessionId,
        timeoutMs,
      },
      { onProgress, signal },
    ): Promise<AiResult> => {
      if (signal.aborted) {
        throw signal.reason;
      }
      const environment = readEnvironment(cwd, dotenv);
      if (!environment.ok) {
        throw new Error(environment.message);
      }

      const controller = new AbortController();
      let timedOut = false;
      const onAbort = (): void => controller.abort(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      try {
        let result: AiResult | undefined;
        for await (const message of query({
          options: {
            abortController: controller,
            cwd,
            // The definition of the workflow must not change while it runs.
            disallowedTools: [`Edit(/${join(cwd, ".aitw")}/**)`],
            // The definition sets variables over what the step inherits.
            env: { ...environment.values, ...env },
            // Nobody can answer a question during a step, so what is not allowed is denied.
            permissionMode: "dontAsk",
            ...(allowedTools === undefined ? {} : { allowedTools }),
            ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
            ...(model === undefined ? {} : { model }),
            ...(schema === undefined
              ? {}
              : { outputFormat: { schema: { ...schema }, type: "json_schema" } }),
            ...(sessionId === undefined ? {} : { resume: sessionId }),
          },
          prompt,
        })) {
          // What a subagent does is part of the step that started it.
          if (message.type === "assistant" && message.parent_tool_use_id === null) {
            for (const block of message.message.content) {
              const line = describeBlock(block);
              if (line !== undefined) {
                onProgress?.(line);
              }
            }
          }
          if (message.type === "result") {
            if (message.subtype !== "success" || message.is_error) {
              throw new Error(describeFailure(message));
            }
            // The AI can finish without returning the result, such as in a session that it continues.
            if (schema !== undefined && message.structured_output === undefined) {
              throw new Error("Claude Code finished without a structured result");
            }
            result = {
              data: schema === undefined ? (message.result ?? "") : message.structured_output,
              sessionId: message.session_id,
            };
          }
        }
        if (result === undefined) {
          throw new Error("Claude Code finished without a result");
        }
        return result;
      } catch (error) {
        if (timedOut) {
          throw new AiTimeoutError(timeoutMs);
        }
        throw signal.aborted ? signal.reason : error;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
    },
    with: optionsSchema,
  });

/** Creates the plugin that runs `ai` steps with Claude Code. */
export const createClaudeCodePlugin = ({
  query = sdkQuery,
}: ClaudeCodePluginOptions = {}): Plugin =>
  definePlugin({ aiProviders: [createProvider(query)], name: "claude" });

/** The plugin that runs `ai` steps with Claude Code, through the Claude Agent SDK. */
export const claudeCodePlugin: Plugin = createClaudeCodePlugin();
