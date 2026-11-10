import { claudeCodePlugin } from "@aitw/adapter-ai-claude-code";
import { createTerminalPlugin, terminalPlugin } from "@aitw/adapter-wait-terminal";
import type { TerminalIO } from "@aitw/adapter-wait-terminal";
import { createPluginRegistry } from "@aitw/core";
import type { PluginRegistry } from "@aitw/core";

/**
 * Creates the registry of the plugins that the CLI loads.
 *
 * @param terminal The terminal that wait steps ask in. Without it, the registry only validates
 *   definitions.
 */
export const createRegistry = (terminal?: TerminalIO): PluginRegistry =>
  createPluginRegistry({
    builtins: [
      terminal === undefined ? terminalPlugin : createTerminalPlugin(terminal),
      claudeCodePlugin,
    ],
  });
