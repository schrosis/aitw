import { evaluateTemplate } from "./evaluate.js";
import type { EvaluateResult } from "./evaluate.js";
import { parseTemplate } from "./template.js";

export { embedValue, evaluateTemplate } from "./evaluate.js";
export type { EvaluateResult } from "./evaluate.js";
export { parseTemplate } from "./template.js";
export type { ParseTemplateResult, Template, TemplatePart } from "./template.js";

/** Parses and evaluates a string that may contain `${{ }}` references. */
export const evaluateExpression = (
  text: string,
  context: Readonly<Record<string, unknown>>,
): EvaluateResult => {
  const parsed = parseTemplate(text);
  return parsed.ok ? evaluateTemplate(parsed.template, context) : parsed;
};
