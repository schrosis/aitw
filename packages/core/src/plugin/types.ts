import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { InputDeclaration } from "../intermediate/index.js";
import type { AiRequest, AiResult, AiRunOptions } from "../ports/ai-runner.js";

/**
 * A way for a `wait` step to wait, such as asking in the terminal or watching a CI run.
 *
 * Its code runs outside the workflow, so that a method cannot break the determinism of the
 * workflow. The workflow only waits for what the intermediate representation describes.
 */
export interface WaitMethod<Options = unknown> {
  /**
   * Name of the method within its plugin, such as `terminal`.
   *
   * It must start with a letter and contain only letters, digits, or `_`.
   */
  name: string;
  /** Schema of the `with` field of a step. It must validate synchronously. */
  with: StandardSchemaV1<unknown, Options>;
  /**
   * Returns the values that the step receives as answers, when the method waits for an answer
   * that someone sends to the workflow.
   *
   * They are stored in the intermediate representation, so that the workflow can validate an
   * answer without the plugin.
   */
  answers?(options: Options): Readonly<Record<string, InputDeclaration>>;
  /**
   * Produces the answers of a step, such as by asking someone in the terminal.
   *
   * It runs in the process that follows the run, such as `aitw run`, while the workflow waits.
   * The workflow validates the values again, and a method that has no answers does not use it.
   *
   * @returns Values of the answers, keyed by name.
   */
  respond?(context: WaitResponseContext<Options>): Promise<Readonly<Record<string, unknown>>>;
}

/** What {@link WaitMethod.respond} receives. */
export interface WaitResponseContext<Options> {
  /** ID of the waiting step. */
  step: string;
  /** Options from `with`, after its expressions are evaluated and the schema is applied. */
  options: Options;
  /** Declarations of the answers that the workflow accepts. */
  answers: Readonly<Record<string, InputDeclaration>>;
  /** Aborted when the run is cancelled, such as by an interrupt. */
  signal: AbortSignal;
}

/** A provider that runs `ai` steps, such as `claude-code`. */
export interface AiProvider<Options = unknown> {
  /**
   * Name of the provider within its plugin, such as `claude-code`.
   *
   * It must start with a letter and contain only letters, digits, `_`, or `-`.
   */
  name: string;
  /** Schema of the `with` field of a step. It must validate synchronously. */
  with: StandardSchemaV1<unknown, Options>;
  /**
   * Runs a step and resolves with its result after it finishes.
   *
   * It must stop the step when the signal is aborted, and throw {@link AiTimeoutError} when the
   * step exceeds `timeoutMs`.
   */
  run(request: AiProviderRequest<Options>, options: AiRunOptions): Promise<AiResult>;
}

/** What {@link AiProvider.run} receives. */
export interface AiProviderRequest<Options> extends Omit<AiRequest, "options" | "provider"> {
  /** Options from `with`, after its expressions are evaluated and the schema is applied. */
  options: Options;
  /** Working directory of the step. */
  cwd: string;
}

/** A package that extends aitw. */
export interface Plugin {
  /**
   * Name that prefixes the names of the extensions of a plugin that is not built in, such as
   * `acme` in `acme/slack`.
   *
   * It must start with a letter and contain only letters, digits, or `_`.
   */
  name: string;
  waitMethods?: readonly WaitMethod[];
  aiProviders?: readonly AiProvider[];
}

/** Declares a plugin. It only checks the type. */
export const definePlugin = (plugin: Plugin): Plugin => plugin;

/** Declares an AI provider, inferring the type of its options from the schema of `with`. */
export const defineAiProvider = <Options>(provider: AiProvider<Options>): AiProvider<Options> =>
  provider;

/** Declares a wait method, inferring the type of its options from the schema of `with`. */
export const defineWaitMethod = <Options>(method: WaitMethod<Options>): WaitMethod<Options> =>
  method;
