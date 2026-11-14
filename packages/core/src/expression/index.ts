import { evaluateTemplate } from "./evaluate.js";
import type { EvaluateResult } from "./evaluate.js";
import { parseTemplate } from "./template.js";

export { conditionReferences, evaluateCondition, parseCondition } from "./condition.js";
export type { Condition, EvaluateConditionResult, ParseConditionResult } from "./condition.js";
export { embedValue, evaluateTemplate, pickReferences } from "./evaluate.js";
export type { EvaluateResult } from "./evaluate.js";
export { parseTemplate } from "./template.js";
export type { ParseTemplateResult, ReferenceOrCall, Template, TemplatePart } from "./template.js";
export type { ValueExpression } from "./value.js";

/** Parses and evaluates a string that may contain `${{ }}` expressions. */
export const evaluateExpression = (
  text: string,
  context: Readonly<Record<string, unknown>>,
): EvaluateResult => {
  const parsed = parseTemplate(text);
  return parsed.ok ? evaluateTemplate(parsed.template, context) : parsed;
};
