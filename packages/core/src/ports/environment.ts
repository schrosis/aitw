/**
 * Port that reads the environment variables that a step sees besides those of its definition.
 *
 * Variables that are already set take precedence over the dotenv file.
 *
 * @param dotenv Path of a dotenv file, relative to the working directory.
 * @throws When the dotenv file cannot be read.
 */
export type EnvironmentReader = (
  dotenv: string | undefined,
) => Readonly<Record<string, string | undefined>>;
