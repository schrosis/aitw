import { createTerminalPlugin, terminalPlugin } from "@aitw/adapter-wait-terminal";
import type { TerminalIO } from "@aitw/adapter-wait-terminal";
import { createPluginRegistry } from "@aitw/core";
import type { PluginRegistry } from "@aitw/core";
import type { MissingHint } from "@aitw/definition";

import { loadProjectConfig } from "./config.js";
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
      terminal === undefined ? terminalPlugin : createTerminalPlugin(terminal),
      ...loaded
        .filter(({ packageName }) => packageName.startsWith(officialScope))
        .map(({ plugin }) => plugin),
    ],
    plugins: loaded
      .filter(({ packageName }) => !packageName.startsWith(officialScope))
      .map(({ plugin }) => plugin),
  });

/**
 * Loads the plugins that `plugins` in the configuration file of a project names, in order.
 *
 * @param cwd Directory that the paths in the messages are relative to.
 * @throws {ProjectConfigError} When the configuration file is invalid.
 * @throws {PluginLoadError} When a plugin cannot be loaded.
 */
export const loadProjectPlugins = async (root: string, cwd: string): Promise<LoadedPlugin[]> => {
  const { plugins = {} } = await loadProjectConfig(root, cwd);
  return loadPlugins(Object.keys(plugins), root);
};

/**
 * Loads plugin packages for a project, in order.
 *
 * @throws {PluginLoadError} When a plugin cannot be loaded.
 */
export const loadPlugins = async (
  packageNames: readonly string[],
  root: string,
): Promise<LoadedPlugin[]> => {
  const loaded: LoadedPlugin[] = [];
  for (const packageName of packageNames) {
    loaded.push(await loadPlugin(packageName, root));
  }
  return loaded;
};
