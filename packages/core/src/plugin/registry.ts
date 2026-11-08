import { identifierPattern } from "../identifier.js";
import type { Plugin, WaitMethod } from "./types.js";

/** Plugins that the CLI or a Worker loads, from which extensions are looked up by name. */
export interface PluginRegistry {
  /** Returns a wait method by the name that a definition uses, such as `terminal`. */
  waitMethod: (name: string) => WaitMethod | undefined;
  /** Names of every wait method, in registration order. */
  waitMethodNames: () => string[];
}

/** Options of {@link createPluginRegistry}. */
export interface PluginRegistryOptions {
  /** Plugins that aitw provides. Their extensions are used without the plugin name. */
  builtins?: readonly Plugin[];
  /** Other plugins. Their extensions are used as `<plugin>/<name>`. */
  plugins?: readonly Plugin[];
}

const checkName = (kind: string, name: string): void => {
  if (!identifierPattern.test(name)) {
    throw new Error(
      `Invalid ${kind} name: ${name}. It must start with a letter and contain only letters, digits, or _`,
    );
  }
};

/**
 * Creates a registry of plugins.
 *
 * @throws When a name is invalid or two extensions have the same name, because that is a mistake
 *   in how aitw or a plugin is put together.
 */
export const createPluginRegistry = ({
  builtins = [],
  plugins = [],
}: PluginRegistryOptions = {}): PluginRegistry => {
  const waitMethods = new Map<string, WaitMethod>();
  const register = (plugin: Plugin, builtin: boolean): void => {
    checkName("plugin", plugin.name);
    for (const method of plugin.waitMethods ?? []) {
      checkName("wait method", method.name);
      const name = builtin ? method.name : `${plugin.name}/${method.name}`;
      if (waitMethods.has(name)) {
        throw new Error(`Duplicate wait method: ${name}`);
      }
      waitMethods.set(name, method);
    }
  };
  for (const plugin of builtins) {
    register(plugin, true);
  }
  for (const plugin of plugins) {
    register(plugin, false);
  }

  return {
    waitMethod: (name) => waitMethods.get(name),
    waitMethodNames: () => [...waitMethods.keys()],
  };
};
