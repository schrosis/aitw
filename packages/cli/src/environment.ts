import type { EnvironmentReader } from "@aitw/core";
import { readEnvironment } from "@aitw/dotenv";

/** Creates the reader of the environment that the steps of a project see. */
export const createEnvironmentReader =
  (cwd: string): EnvironmentReader =>
  (dotenv) => {
    const environment = readEnvironment(cwd, dotenv);
    if (!environment.ok) {
      throw new Error(environment.message);
    }
    return environment.values;
  };
