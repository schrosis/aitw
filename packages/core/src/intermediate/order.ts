import type { Intermediate, Transition } from "./schema.js";

/**
 * Returns the IDs of the steps on the path from `start`, in execution order.
 *
 * It stops at an unknown step or at a step that was already visited, so it also works on an
 * intermediate representation whose transitions are invalid.
 */
export const executionOrder = ({ start, steps }: Intermediate): string[] => {
  const visited = new Set<string>();
  let current: string | null = start;
  while (current !== null && Object.hasOwn(steps, current) && !visited.has(current)) {
    visited.add(current);
    const transition: Transition | undefined = steps[current]?.next;
    current = transition?.type === "step" ? transition.step : null;
  }
  // A Set keeps the insertion order.
  return [...visited];
};
