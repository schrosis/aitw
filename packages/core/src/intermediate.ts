import { z } from "zod";

/** Version of the intermediate representation format. */
export const intermediateVersion = 1;

const stepIdSchema = z.string().min(1);
const expressionMapSchema = z.record(z.string().min(1), z.string().min(1));

const scriptStepSchema = z.strictObject({
  type: z.literal("script"),
  run: z.string().min(1),
  /** Next step ID, or `null` to complete the workflow. */
  next: stepIdSchema.nullable(),
  timeoutMs: z.int().positive(),
  input: expressionMapSchema,
  output: expressionMapSchema,
});

/** Schema of the intermediate representation that the engine executes. */
export const intermediateSchema = z.strictObject({
  version: z.literal(intermediateVersion),
  start: stepIdSchema,
  steps: z.record(stepIdSchema, z.discriminatedUnion("type", [scriptStepSchema])),
});

/** A workflow in the intermediate representation. */
export type Intermediate = z.infer<typeof intermediateSchema>;

/** A step in the intermediate representation. */
export type IntermediateStep = Intermediate["steps"][string];

/** A problem found in an intermediate representation. */
export interface ValidationError {
  /** Path of the invalid value in the intermediate representation. */
  path: (number | string)[];
  message: string;
}

/** Result of {@link validateIntermediate}. */
export type ValidationResult =
  | { ok: true; intermediate: Intermediate }
  | { ok: false; errors: ValidationError[] };

const validateTransitions = (intermediate: Intermediate): ValidationError[] => {
  const errors: ValidationError[] = [];
  const { start, steps } = intermediate;

  if (!Object.hasOwn(steps, start)) {
    errors.push({ message: `Unknown step: ${start}`, path: ["start"] });
  }

  const sources = new Map<string, string>();
  for (const [id, { next }] of Object.entries(steps)) {
    if (next === null) {
      continue;
    }
    const path = ["steps", id, "next"];
    if (!Object.hasOwn(steps, next)) {
      errors.push({ message: `Unknown step: ${next}`, path });
    } else if (next === start) {
      errors.push({ message: `Cannot transition to the start step: ${next}`, path });
    } else if (sources.has(next)) {
      errors.push({
        message: `Step ${next} is already the next step of ${sources.get(next)}`,
        path,
      });
    } else {
      sources.set(next, id);
    }
  }

  const reachable = new Set<string>();
  for (let id: string | null = start; id !== null && Object.hasOwn(steps, id);) {
    if (reachable.has(id)) {
      break;
    }
    reachable.add(id);
    id = steps[id]?.next ?? null;
  }
  for (const id of Object.keys(steps)) {
    if (!reachable.has(id)) {
      errors.push({ message: "Step is not reachable from start", path: ["steps", id] });
    }
  }

  return errors;
};

/**
 * Validates the shape and transitions of an intermediate representation.
 *
 * The first version accepts only a single path from `start` to completion.
 */
export const validateIntermediate = (input: unknown): ValidationResult => {
  const result = intermediateSchema.safeParse(input);
  if (!result.success) {
    return {
      errors: result.error.issues.map(({ message, path }) => ({
        message,
        path: path.filter((segment) => typeof segment !== "symbol"),
      })),
      ok: false,
    };
  }

  const errors = validateTransitions(result.data);
  return errors.length > 0 ? { errors, ok: false } : { intermediate: result.data, ok: true };
};
