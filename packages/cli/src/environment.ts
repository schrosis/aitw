import type { EnvironmentReader } from "@aitw/core";
import { readDotenv } from "@aitw/dotenv";

/** Creates the reader of the environment that the steps of a project see. */
export const createEnvironmentReader =
  (cwd: string): EnvironmentReader =>
  (dotenv) => {
    if (dotenv === undefined) {
      return process.env;
    }
    const file = readDotenv(cwd, dotenv);
    if (!file.ok) {
      throw new Error(file.message);
    }
    return { ...file.values, ...process.env };
  };
