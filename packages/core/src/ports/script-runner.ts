/** A request to run a script step. */
export interface ScriptRequest {
  /** Command line to run in a shell. */
  run: string;
  /** Evaluated input values of the step. */
  input: Record<string, string>;
  /**
   * Maximum duration of the script in milliseconds.
   *
   * The runner must stop the script and report a failure when it is exceeded.
   */
  timeoutMs: number;
}

/** The result of a finished script. */
export interface ScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Port that runs scripts for script steps. */
export interface ScriptRunner {
  /**
   * Runs a script.
   *
   * The runner must stop the script when `signal` is aborted.
   */
  run: (request: ScriptRequest, signal: AbortSignal) => Promise<ScriptResult>;
}
