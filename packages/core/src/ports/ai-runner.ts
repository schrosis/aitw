/** A request to run an AI step. */
export interface AiRequest {
  /** Name of the provider that runs the step, such as `claude-code`. */
  provider: string;
  /** Instructions of the step, after its expressions are evaluated. */
  prompt: string;
  /** Model to use, passed as the definition writes it. The provider chooses one when absent. */
  model?: string | undefined;
  /** JSON Schema of the result. Without it, the result is text. */
  schema?: Readonly<Record<string, unknown>> | undefined;
  /** Session to continue. A new session starts when it is absent. */
  sessionId?: string | undefined;
  /** Options of the provider from `with`, after their expressions are evaluated. */
  options: Readonly<Record<string, unknown>>;
  /** Environment variables that the definition sets, after their expressions are evaluated. */
  env?: Readonly<Record<string, string>> | undefined;
  /**
   * Path of a dotenv file, relative to the working directory, read each time a step runs. Its
   * values do not replace variables that are already set, and a file that cannot be read fails
   * the step.
   */
  dotenv?: string | undefined;
  /**
   * Maximum duration of the step in milliseconds.
   *
   * The runner must stop the step and throw {@link AiTimeoutError} when it is exceeded.
   */
  timeoutMs: number;
}

/** The result of a finished AI step. */
export interface AiResult {
  /** The result: text without a schema, or a value of the type of the schema. */
  data: unknown;
  /** Session that a later run of the step can continue, when the provider has sessions. */
  sessionId?: string | undefined;
}

/** Options of {@link AiRunner.run}. */
export interface AiRunOptions {
  /** The runner must stop the step when it is aborted. */
  signal: AbortSignal;
  /** Receives what the AI says and does, one summary per call, ending with a newline. */
  onProgress?: ((text: string) => void) | undefined;
}

/** Port that runs AI steps. */
export interface AiRunner {
  /** Runs a step and resolves with its result after it finishes. */
  run: (request: AiRequest, options: AiRunOptions) => Promise<AiResult>;
}

/** Error that an AI runner throws when a step exceeds its timeout. */
export class AiTimeoutError extends Error {
  override readonly name = "AiTimeoutError";

  constructor(readonly timeoutMs: number) {
    super(`AI step timed out after ${timeoutMs} ms`);
  }
}
