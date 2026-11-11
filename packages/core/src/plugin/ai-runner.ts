import type { AiRunner } from "../ports/ai-runner.js";
import type { PluginRegistry } from "./registry.js";
import { validateWithSchema } from "./schema.js";

/** Options of {@link createAiRunner}. */
export interface AiRunnerOptions {
  /** Plugins that provide the AI providers. */
  plugins: PluginRegistry;
  /** Working directory of the steps. */
  cwd: string;
}

/**
 * Creates an AI runner that runs each step with the provider that it names.
 *
 * The options are validated again, because their expressions are evaluated only when the step
 * runs.
 */
export const createAiRunner = ({ cwd, plugins }: AiRunnerOptions): AiRunner => ({
  run: async ({ options, provider: name, ...request }, runOptions) => {
    const provider = plugins.aiProvider(name);
    if (provider === undefined) {
      throw new Error(`Unknown AI provider: ${name}`);
    }
    const validated = validateWithSchema(provider.with, options);
    if (!validated.ok) {
      const reasons = validated.errors.map(({ message, path }) =>
        path.length > 0 ? `${path.join(".")}: ${message}` : message,
      );
      throw new Error(`Invalid options of AI provider ${name}: ${reasons.join(", ")}`);
    }
    return provider.run(
      { ...request, config: plugins.aiProviderConfig(name), cwd, options: validated.value },
      runOptions,
    );
  },
});
