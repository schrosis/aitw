import { readFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Plugin } from "@aitw/core";

/** A plugin that a project loads, and the package that provides it. */
export interface LoadedPlugin {
  /** Name of the package, such as `@acme/aitw-slack`. */
  packageName: string;
  plugin: Plugin;
  /** Settings of the plugin, after its `config` schema is applied. */
  config?: unknown;
}

/** Thrown when a plugin that a project names cannot be loaded. */
export class PluginLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginLoadError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Conditions of `exports` that aitw loads a plugin with. */
const conditions: ReadonlySet<string> = new Set(["node", "import", "default"]);

/** Returns the target of `exports` for the conditions of aitw, or `undefined`. */
const exportTarget = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = exportTarget(item);
      if (target !== undefined) {
        return target;
      }
    }
    return undefined;
  }
  if (isRecord(value)) {
    // As in Node, the first condition that matches in the order of the keys is taken.
    for (const [condition, nested] of Object.entries(value)) {
      if (conditions.has(condition)) {
        const target = exportTarget(nested);
        if (target !== undefined) {
          return target;
        }
      }
    }
  }
  return undefined;
};

/** Returns the module that the root of a package exports, from its `package.json`. */
const entryOf = (manifest: Record<string, unknown>): string | undefined => {
  const { exports } = manifest;
  if (exports === undefined) {
    return typeof manifest.main === "string" ? manifest.main : "index.js";
  }
  // `exports` maps subpaths when its keys start with a dot, and is the root export otherwise.
  const root =
    isRecord(exports) && Object.keys(exports).some((key) => key.startsWith("."))
      ? exports["."]
      : exports;
  return exportTarget(root);
};

/**
 * Finds the `package.json` of a package, from the project first and then from aitw itself.
 *
 * Looking next to aitw lets a plugin that is installed globally with aitw be used.
 */
const findManifest = (packageName: string, root: string): string | undefined => {
  for (const base of [pathToFileURL(join(root, "/")).href, import.meta.url]) {
    try {
      const found = findPackageJSON(packageName, base);
      if (found !== undefined) {
        return found;
      }
    } catch {
      // The package is not installed there.
    }
  }
  return undefined;
};

const isPlugin = (value: unknown): value is Plugin =>
  typeof value === "object" &&
  value !== null &&
  "name" in value &&
  typeof value.name === "string" &&
  (!("waitMethods" in value) ||
    value.waitMethods === undefined ||
    Array.isArray(value.waitMethods)) &&
  (!("aiProviders" in value) ||
    value.aiProviders === undefined ||
    Array.isArray(value.aiProviders));

/**
 * Loads a plugin package, whose default export is the plugin.
 *
 * The package runs in this process, so a project must trust the plugins that it names, as it
 * trusts the scripts of its workflows.
 *
 * @throws {PluginLoadError} When the package is not installed, or does not export a plugin.
 */
export const loadPlugin = async (packageName: string, root: string): Promise<LoadedPlugin> => {
  const manifestFile = findManifest(packageName, root);
  if (manifestFile === undefined) {
    throw new PluginLoadError(
      `Plugin ${packageName} is not installed in the project or next to aitw. Install it, such as with "npm install --save-dev ${packageName}"`,
    );
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  } catch (error) {
    throw new PluginLoadError(
      `Plugin ${packageName} has an unreadable package.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const entry = isRecord(manifest) ? entryOf(manifest) : undefined;
  if (entry === undefined) {
    throw new PluginLoadError(`Plugin ${packageName} exports no module for import`);
  }
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(join(dirname(manifestFile), entry)).href);
  } catch (error) {
    throw new PluginLoadError(
      `Plugin ${packageName} failed to load: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const plugin =
    typeof loaded === "object" && loaded !== null && "default" in loaded
      ? loaded.default
      : undefined;
  if (!isPlugin(plugin)) {
    throw new PluginLoadError(
      `Plugin ${packageName} does not export a plugin as its default export. Export the result of definePlugin as default`,
    );
  }
  return { packageName, plugin };
};
