import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { toJsonSchema } from "@aitw/core";
import { createDefinitionJsonSchema } from "@aitw/definition";
import { z } from "zod";

import { projectConfigSchema } from "../config.js";
import type { LoadedPlugin } from "../plugin-loader.js";
import { createRegistry, loadProjectPlugins } from "../plugins.js";
import { aitwDirectory, findProjectRoot } from "../workflows.js";
import type { CommandContext } from "./load.js";

/** Directory of the generated JSON Schemas, in `.aitw`. */
export const schemaDirectory = "schemas";

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Creates the JSON Schema of the configuration file of a project.
 *
 * The settings of each plugin that the project loads follow the `config` schema of the plugin.
 * A plugin without it takes no settings.
 */
export const createProjectConfigJsonSchema = (loaded: readonly LoadedPlugin[]): JsonObject => {
  const schema: JsonObject = z.toJSONSchema(projectConfigSchema, {
    io: "input",
    target: "draft-7",
  });
  // An empty file is null, so the object is one of the options.
  const options = Array.isArray(schema.anyOf) ? schema.anyOf.filter(isJsonObject) : [schema];
  const config = options.find((option) => isJsonObject(option.properties));
  const plugins = isJsonObject(config?.properties) ? config.properties.plugins : undefined;
  if (!isJsonObject(plugins)) {
    throw new Error("The JSON Schema of the configuration file has no plugins");
  }
  plugins.properties = Object.fromEntries(
    loaded.map(({ packageName, plugin }) => [
      packageName,
      {
        anyOf: [
          { type: "null" },
          plugin.config === undefined
            ? { maxProperties: 0, type: "object" }
            : (toJsonSchema(plugin.config) ?? {}),
        ],
      },
    ]),
  );
  return schema;
};

/** Writes a JSON Schema, and returns its path relative to the current directory. */
const write = async (file: string, schema: JsonObject, cwd: string): Promise<string> => {
  await writeFile(file, `${JSON.stringify(schema, null, 2)}\n`);
  return relative(cwd, file);
};

/**
 * Generates the JSON Schemas of the workflow definitions and the configuration file of the
 * project in `.aitw/schemas`, with the extensions of the plugins that the project loads.
 *
 * @returns The exit code of the command.
 */
export const schema = async (context: CommandContext): Promise<number> => {
  const root = await findProjectRoot(context.cwd);
  if (root === undefined) {
    context.stderr(`No ${aitwDirectory} directory found in ${context.cwd} or its parents\n`);
    return 1;
  }
  try {
    const loaded = await loadProjectPlugins(root, context.cwd);
    const directory = join(root, aitwDirectory, schemaDirectory);
    await mkdir(directory, { recursive: true });
    const written = [
      await write(
        join(directory, "workflow.schema.json"),
        createDefinitionJsonSchema({ plugins: createRegistry(undefined, loaded) }),
        context.cwd,
      ),
      await write(
        join(directory, "config.schema.json"),
        createProjectConfigJsonSchema(loaded),
        context.cwd,
      ),
    ];
    for (const file of written) {
      context.stdout(`wrote ${file}\n`);
    }
    return 0;
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};
