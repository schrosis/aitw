/** A request to run a script step. */
export interface ScriptRequest {
  /** Command line to run in a shell. */
  run: string;
  /** Evaluated input values of the step. */
  input: Readonly<Record<string, unknown>>;
  /**
   * Maximum duration of the script in milliseconds.
   *
   * The runner must stop the script and throw {@link ScriptTimeoutError} when it is exceeded.
   */
  timeoutMs: number;
}

/** The result of a finished script. */
export interface ScriptResult {
  /** Exit code, or `null` when a signal stopped the script. */
  exitCode: number | null;
  /** Signal that stopped the script, or `null` when it exited. */
  signal: string | null;
  stdout: string;
  stderr: string;
}

/** A chunk of output that a script wrote. */
export interface ScriptOutput {
  stream: "stdout" | "stderr";
  text: string;
}

/** Options of {@link ScriptRunner.run}. */
export interface ScriptRunOptions {
  /** The runner must stop the script when it is aborted. */
  signal: AbortSignal;
  /** Receives output as the script writes it. */
  onOutput?: ((output: ScriptOutput) => void) | undefined;
}

/** Port that runs scripts for script steps. */
export interface ScriptRunner {
  /** Runs a script and resolves with its result after it exits. */
  run: (request: ScriptRequest, options: ScriptRunOptions) => Promise<ScriptResult>;
}

/** Error that a script runner throws when a script exceeds its timeout. */
export class ScriptTimeoutError extends Error {
  override readonly name = "ScriptTimeoutError";

  constructor(readonly timeoutMs: number) {
    super(`Script timed out after ${timeoutMs} ms`);
  }
}
