import { identifierPattern } from "../identifier.js";
import type { AiProvider, Plugin, WaitMethod } from "./types.js";

/** Plugins that the CLI or a Worker loads, from which extensions are looked up by name. */
export interface PluginRegistry {
  /** Returns a wait method by the name that a definition uses, such as `terminal`. */
  waitMethod: (name: string) => WaitMethod | undefined;
  /** Names of every wait method, in registration order. */
  waitMethodNames: () => string[];
  /** Returns an AI provider by the name that a definition uses, such as `claude-code`. */
  aiProvider: (name: string) => AiProvider | undefined;
  /** Names of every AI provider, in registration order. */
  aiProviderNames: () => string[];
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

// Providers are named after products, such as claude-code.
const providerNamePattern = /^[A-Za-z][A-Za-z0-9_-]*$/u;

const checkProviderName = (name: string): void => {
  if (!providerNamePattern.test(name)) {
    throw new Error(
      `Invalid AI provider name: ${name}. It must start with a letter and contain only letters, digits, _, or -`,
    );
  }
};

/**
 * Creates a registry of plugins.
 *
 * @throws When a name is invalid, or two plugins or two extensions have the same name, because
 *   that is a mistake
 *   in how aitw or a plugin is put together.
 */
export const createPluginRegistry = ({
  builtins = [],
  plugins = [],
}: PluginRegistryOptions = {}): PluginRegistry => {
  const pluginNames = new Set<string>();
  const waitMethods = new Map<string, WaitMethod>();
  const aiProviders = new Map<string, AiProvider>();
  const register = (plugin: Plugin, builtin: boolean): void => {
    checkName("plugin", plugin.name);
    // The name of a plugin is the namespace of its extensions, including for built-in plugins.
    if (pluginNames.has(plugin.name)) {
      throw new Error(`Duplicate plugin: ${plugin.name}`);
    }
    pluginNames.add(plugin.name);
    for (const method of plugin.waitMethods ?? []) {
      checkName("wait method", method.name);
      const name = builtin ? method.name : `${plugin.name}/${method.name}`;
      if (waitMethods.has(name)) {
        throw new Error(`Duplicate wait method: ${name}`);
      }
      waitMethods.set(name, method);
    }
    for (const provider of plugin.aiProviders ?? []) {
      checkProviderName(provider.name);
      const name = builtin ? provider.name : `${plugin.name}/${provider.name}`;
      if (aiProviders.has(name)) {
        throw new Error(`Duplicate AI provider: ${name}`);
      }
      aiProviders.set(name, provider);
    }
  };
  for (const plugin of builtins) {
    register(plugin, true);
  }
  for (const plugin of plugins) {
    register(plugin, false);
  }

  return {
    aiProvider: (name) => aiProviders.get(name),
    aiProviderNames: () => [...aiProviders.keys()],
    waitMethod: (name) => waitMethods.get(name),
    waitMethodNames: () => [...waitMethods.keys()],
  };
};
