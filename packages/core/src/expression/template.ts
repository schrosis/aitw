import { identifierSource } from "../identifier.js";

/** A part of a template: literal text or a reference such as `steps.fetch.outputs.title`. */
export type TemplatePart =
  | { type: "text"; value: string }
  | { type: "reference"; path: string[]; source: string };

/** A string that may contain `${{ }}` references. */
export type Template = TemplatePart[];

/** Result of {@link parseTemplate}. */
export type ParseTemplateResult = { ok: true; template: Template } | { ok: false; message: string };

const segmentPattern = new RegExp(`^${identifierSource}(?:\\[\\d+\\])?$`, "u");

/** Splits the indexes off the segments of a path, such as `visits[0]` into `visits` and `0`. */
export const expandIndexes = (segments: readonly string[]): string[] =>
  segments.flatMap((segment) => {
    const match = /^(?<name>[^[\]]+)\[(?<index>\d+)\]$/u.exec(segment);
    return match?.groups?.name !== undefined && match.groups.index !== undefined
      ? [match.groups.name, match.groups.index]
      : [segment];
  });

const open = "${{";
const close = "}}";

/**
 * Parses the `${{ }}` references in a string.
 *
 * A reference is a dot-separated path of names, each of which can have an index such as
 * `visits[0]`. Functions and operators are not supported.
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
    const segments = text
      .slice(start + open.length, end)
      .trim()
      .split(".");
    if (!segments.every((segment) => segmentPattern.test(segment))) {
      return {
        message: `Invalid expression: ${source}. Use a reference such as steps.fetch.outputs.title`,
        ok: false,
      };
    }
    template.push({ path: expandIndexes(segments), source, type: "reference" });
    position = end + close.length;
  }

  return { ok: true, template };
};
