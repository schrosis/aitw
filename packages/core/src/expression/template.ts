import { identifierPattern } from "../identifier.js";

/** A part of a template: literal text or a reference such as `steps.fetch.output.title`. */
export type TemplatePart =
  | { type: "text"; value: string }
  | { type: "reference"; path: string[]; source: string };

/** A string that may contain `${{ }}` references. */
export type Template = TemplatePart[];

/** Result of {@link parseTemplate}. */
export type ParseTemplateResult = { ok: true; template: Template } | { ok: false; message: string };

const open = "${{";
const close = "}}";

/**
 * Parses the `${{ }}` references in a string.
 *
 * A reference is a dot-separated path of names. Functions and operators are not supported.
 */
export const parseTemplate = (text: string): ParseTemplateResult => {
  const template: Template = [];
  let position = 0;

  while (position < text.length) {
    const start = text.indexOf(open, position);
    if (start === -1) {
      template.push({ type: "text", value: text.slice(position) });
      break;
    }
    if (start > position) {
      template.push({ type: "text", value: text.slice(position, start) });
    }

    const end = text.indexOf(close, start + open.length);
    if (end === -1) {
      return { message: `Unterminated expression: ${text.slice(start)}`, ok: false };
    }

    const source = text.slice(start, end + close.length);
    const path = text
      .slice(start + open.length, end)
      .trim()
      .split(".");
    if (!path.every((segment) => identifierPattern.test(segment))) {
      return {
        message: `Invalid expression: ${source}. Use a reference such as steps.fetch.output.title`,
        ok: false,
      };
    }
    template.push({ path, source, type: "reference" });
    position = end + close.length;
  }

  return { ok: true, template };
};
