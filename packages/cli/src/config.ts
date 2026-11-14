import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { parseYaml } from "@ugoke/definition";
import { z } from "zod";

import { formatError } from "./commands/load.js";
import { ugokeDirectory } from "./workflows.js";

/** Names of the configuration file of a project, in `.ugoke`. */
const configNames = ["config.yaml", "config.yml"];

/** Name of an npm package, with or without a scope. */
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;

/** Schema of the configuration file of a project. Unknown fields are rejected. */
export const projectConfigSchema = z
  .strictObject({
    $schema: z
      .string()
      .optional()
      .describe("JSON Schema of the file for editors, such as ./schemas/config.schema.json"),
    output: z
      .strictObject({
        showCommands: z
          .boolean()
          .optional()
          .describe(
            "Whether the progress shows what a step runs: the run of a script step and the prompt of an AI step. It is shown by default",
          ),
      })
      .optional()
      .describe("How ugoke run and ugoke attach show the progress of a run"),
    plugins: z
      .record(
        z
          .string()
          .regex(
            packageNamePattern,
            "Must be the name of an npm package, such as @acme/ugoke-slack",
          ),
        // Settings of the plugin, which its config schema validates after it loads.
        z.record(z.string(), z.json()).nullable(),
      )
      .optional()
      .describe(
        "Plugin packages to load, keyed by package name, such as @ugoke/adapter-ai-claude-code. They are found in the project, and then next to ugoke. The value is the settings of the plugin, which its config schema validates",
      ),
    temporal: z
      .strictObject({
        address: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Address of the Temporal Server of the project, such as temporal.example.com:7233. The server of ugoke daemon is used by default",
          ),
      })
      .optional(),
  })
  // An empty file has no settings.
  .nullable()
  .transform((config) => config ?? {});

/** Settings of a project, from `.ugoke/config.yaml`. */
export type ProjectConfig = z.output<typeof projectConfigSchema>;

/** Thrown when the configuration file of a project cannot be read or is invalid. */
export class ProjectConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectConfigError";
  }
}

/** Reads a file, or returns `undefined` when it does not exist. */
const readIfExists = async (file: string): Promise<string | undefined> => {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};

/** A configuration file that was read, with what reports problems in it. */
export interface ReadProjectConfig {
  config: ProjectConfig;
  /**
   * Builds the error for problems found later in the file, such as invalid settings of a plugin.
   *
   * @param errors Problems with paths in the file, such as `["plugins", "@acme/x", "channel"]`.
   */
  error: (errors: readonly { message: string; path: (number | string)[] }[]) => ProjectConfigError;
}

/**
 * Reads the configuration file of a project, `.ugoke/config.yaml`.
 *
 * It is read again for every command, so that a change applies without restarting
 * `ugoke daemon`. A project without the file has no settings.
 *
 * @param cwd Directory that the paths in the messages are relative to.
 * @throws {ProjectConfigError} When the file cannot be read or is invalid.
 */
export const loadProjectConfig = async (root: string, cwd: string): Promise<ProjectConfig> =>
  (await readProjectConfig(root, cwd)).config;

/**
 * Reads the configuration file of a project, and keeps what locates problems in it.
 *
 * @throws {ProjectConfigError} When the file cannot be read or is invalid.
 */
export const readProjectConfig = async (root: string, cwd: string): Promise<ReadProjectConfig> => {
  const found: { file: string; source: string }[] = [];
  for (const name of configNames) {
    const file = join(root, ugokeDirectory, name);
    let source: string | undefined;
    try {
      source = await readIfExists(file);
    } catch (error) {
      throw new ProjectConfigError(
        `${relative(cwd, file)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (source !== undefined) {
      found.push({ file, source });
    }
  }
  const [config, other] = found;
  if (config === undefined) {
    return {
      config: {},
      // A project without the file has no settings that could be invalid.
      error: (errors) => new ProjectConfigError(errors.map(({ message }) => message).join("\n")),
    };
  }
  if (other !== undefined) {
    throw new ProjectConfigError(
      `${relative(cwd, join(root, ugokeDirectory))} has both config.yaml and config.yml. Keep one of them`,
    );
  }

  const file = relative(cwd, config.file);
  const result = parseYaml(config.source, projectConfigSchema);
  if (!result.ok) {
    throw new ProjectConfigError(
      result.errors
        .map((error) => formatError(file, error))
        .join("")
        .trimEnd(),
    );
  }
  return {
    config: result.value,
    error: (errors) =>
      new ProjectConfigError(
        errors
          .map(({ message, path }) => formatError(file, { ...result.locate(path), message, path }))
          .join("")
          .trimEnd(),
      ),
  };
};
