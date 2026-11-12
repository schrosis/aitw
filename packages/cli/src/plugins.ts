import { createTerminalPlugin, terminalPlugin } from "@aitw/adapter-wait-terminal";
import type { TerminalIO } from "@aitw/adapter-wait-terminal";
import { createPluginRegistry, validatePluginConfig } from "@aitw/core";
import type { PluginRegistry } from "@aitw/core";
import type { MissingHint } from "@aitw/definition";

import { readProjectConfig } from "./config.js";
import type { ReadProjectConfig } from "./config.js";
import { loadPlugin } from "./plugin-loader.js";
import type { LoadedPlugin } from "./plugin-loader.js";

/** Scope of the plugins that aitw publishes, whose extensions are used without the plugin name. */
const officialScope = "@aitw/";

/** Packages of the official plugins, keyed by the names of the AI providers that they provide. */
const officialAiProviders: Readonly<Record<string, string>> = {
  "claude-code": "@aitw/adapter-ai-claude-code",
};

/**
 * Tells which package provides an official extension that no loaded plugin provides.
 *
 * Only the terminal is built in, so a project installs and names the other plugins.
 */
export const missingHint: MissingHint = (kind, name) => {
  const packageName = kind === "aiProvider" ? officialAiProviders[name] : undefined;
  return packageName === undefined
    ? undefined
    : `Install ${packageName} and add it to plugins in .aitw/config.yaml`;
};

/**
 * Creates the registry of the plugins that the CLI loads.
 *
 * Extensions of the plugins that aitw publishes are used by their own names, such as
 * `claude-code`, and those of other plugins as `<plugin>/<name>`.
 *
 * @param terminal The terminal that wait steps ask in. Without it, the registry only validates
 *   definitions.
 * @param loaded Plugins that the project names.
 * @throws When two plugins or extensions have the same name.
 */
export const createRegistry = (
  terminal?: TerminalIO,
  loaded: readonly LoadedPlugin[] = [],
): PluginRegistry =>
  createPluginRegistry({
    builtins: [
      // The progress of the run shows the message of a wait step, as it does for other methods.
      terminal === undefined
        ? terminalPlugin
        : createTerminalPlugin(terminal, { showMessage: false }),
      ...loaded
        .filter(({ packageName }) => packageName.startsWith(officialScope))
        .map(({ plugin }) => plugin),
    ],
    plugins: loaded
      .filter(({ packageName }) => !packageName.startsWith(officialScope))
      .map(({ plugin }) => plugin),
    configs: new Map(loaded.map(({ config, plugin }) => [plugin.name, config])),
  });

/**
 * Loads the plugins that `plugins` in the configuration file of a project names, in order, and
 * validates their settings.
 *
 * @param cwd Directory that the paths in the messages are relative to.
 * @throws {ProjectConfigError} When the configuration file or the settings of a plugin are
 *   invalid.
 * @throws {PluginLoadError} When a plugin cannot be loaded.
 */
export const loadProjectPlugins = async (root: string, cwd: string): Promise<LoadedPlugin[]> =>
  loadConfiguredPlugins(await readProjectConfig(root, cwd), root);

/**
 * Loads the plugins of a configuration file that was read, and validates their settings.
 *
 * @throws {ProjectConfigError} When the settings of plugins are invalid, with every problem.
 * @throws {PluginLoadError} When a plugin cannot be loaded.
 */
export const loadConfiguredPlugins = async (
  { config, error }: ReadProjectConfig,
  root: string,
): Promise<LoadedPlugin[]> => {
  const loaded: LoadedPlugin[] = [];
  // Invalid settings of every plugin are reported together, as problems of the file are.
  const problems: { message: string; path: (number | string)[] }[] = [];
  for (const [packageName, settings] of Object.entries(config.plugins ?? {})) {
    const { plugin } = await loadPlugin(packageName, root);
    const validated = validatePluginConfig(plugin, settings);
    if (validated.ok) {
      loaded.push({ config: validated.value, packageName, plugin });
    } else {
      problems.push(
        ...validated.errors.map(({ message, path }) => ({
          message,
          path: ["plugins", packageName, ...path],
        })),
      );
    }
  }
  if (problems.length > 0) {
    throw error(problems);
  }
  return loaded;
};
