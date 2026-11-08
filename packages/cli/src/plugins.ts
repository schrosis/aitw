import { terminalPlugin } from "@aitw/adapter-wait-terminal";
import { createPluginRegistry } from "@aitw/core";
import type { PluginRegistry } from "@aitw/core";

/** Plugins that aitw provides, whose extensions definitions use without a plugin name. */
const builtins = [terminalPlugin];

/** Creates the registry of the plugins that the CLI loads. */
export const createRegistry = (): PluginRegistry => createPluginRegistry({ builtins });
