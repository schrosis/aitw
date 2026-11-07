export const packageName = "@aitw/core";

export {
  intermediateSchema,
  intermediateVersion,
  validateIntermediate,
} from "./intermediate/index.js";
export type {
  Intermediate,
  IntermediateStep,
  Transition,
  ValidationError,
  ValidationResult,
} from "./intermediate/index.js";
