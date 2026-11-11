import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { InputDeclaration } from "../intermediate/index.js";
import type { AiRequest, AiResult, AiRunOptions } from "../ports/ai-runner.js";

/**
 * A way for a `wait` step to wait, such as asking in the terminal or watching a CI run.
 *
 * Its code runs outside the workflow, so that a method cannot break the determinism of the
 * workflow. The workflow only waits for what the intermediate representation describes.
 */
export interface WaitMethod<Options = unknown, Config = unknown> {
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
  answers?(options: Options, config: Config): Readonly<Record<string, InputDeclaration>>;
  /**
   * Produces the answers of a step, such as by asking someone in the terminal.
   *
   * It runs in the process that follows the run, such as `aitw run`, while the workflow waits.
   * The workflow validates the values again, and a method that has no answers does not use it.
   *
   * @returns Values of the answers, keyed by name.
   */
  respond?(
    context: WaitResponseContext<Options, Config>,
  ): Promise<Readonly<Record<string, unknown>>>;
}

/** What {@link WaitMethod.respond} receives. */
export interface WaitResponseContext<Options, Config = unknown> {
  /** ID of the waiting step. */
  step: string;
  /** Options from `with`, after its expressions are evaluated and the schema is applied. */
  options: Options;
  /** Settings of the plugin, after its `config` schema is applied. */
  config: Config;
  /** Declarations of the answers that the workflow accepts. */
  answers: Readonly<Record<string, InputDeclaration>>;
  /** Aborted when the run is cancelled, such as by an interrupt. */
  signal: AbortSignal;
}

/** A provider that runs `ai` steps, such as `claude-code`. */
export interface AiProvider<Options = unknown, Config = unknown> {
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
  run(request: AiProviderRequest<Options, Config>, options: AiRunOptions): Promise<AiResult>;
}

/** What {@link AiProvider.run} receives. */
export interface AiProviderRequest<Options, Config = unknown> extends Omit<
  AiRequest,
  "options" | "provider"
> {
  /** Options from `with`, after its expressions are evaluated and the schema is applied. */
  options: Options;
  /** Settings of the plugin, after its `config` schema is applied. */
  config: Config;
  /** Working directory of the step. */
  cwd: string;
}

/** A package that extends aitw. */
export interface Plugin<Config = unknown> {
  /**
   * Name that prefixes the names of the extensions of a plugin that is not built in, such as
   * `acme` in `acme/slack`.
   *
   * It must start with a letter and contain only letters, digits, or `_`.
   */
  name: string;
  /**
   * Schema of the settings of the plugin, which a project writes under the package name in
   * `plugins` of `.aitw/config.yaml`. It must validate synchronously. A plugin without it takes
   * no settings.
   */
  config?: StandardSchemaV1<unknown, Config>;
  waitMethods?: readonly WaitMethod<unknown, Config>[];
  aiProviders?: readonly AiProvider<unknown, Config>[];
}

/** Declares a plugin, inferring the type of its settings from the schema of `config`. */
export const definePlugin = <Config = undefined>(plugin: Plugin<Config>): Plugin<Config> => plugin;

/**
 * Declares an AI provider, inferring the type of its options from the schema of `with`.
 *
 * Give `Config` to read the settings of its plugin.
 */
export const defineAiProvider = <Options, Config = unknown>(
  provider: AiProvider<Options, Config>,
): AiProvider<Options, Config> => provider;

/**
 * Declares a wait method, inferring the type of its options from the schema of `with`.
 *
 * Give `Config` to read the settings of its plugin.
 */
export const defineWaitMethod = <Options, Config = unknown>(
  method: WaitMethod<Options, Config>,
): WaitMethod<Options, Config> => method;
