import { loadWorkflow } from "./load.js";
import type { CommandContext } from "./load.js";

/**
 * Validates a workflow definition.
 *
 * @returns The exit code of the command.
 */
export const validate = async (name: string, context: CommandContext): Promise<number> => {
  if ((await loadWorkflow(name, context)) === undefined) {
    return 1;
  }
  context.stdout(`${name}: valid\n`);
  return 0;
};
