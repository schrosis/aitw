export const packageName = "@aitw/definition";

export {
  createDefinitionJsonSchema,
  defaultStepTimeout,
  definitionSchema,
  definitionVersion,
} from "./schema.js";
export type { Definition } from "./schema.js";
export { parseDefinition } from "./parse.js";
export type { ParseError, ParseResult } from "./parse.js";
export { buildIntermediate } from "./build.js";
