import type { Intermediate, Transition } from "./schema.js";

/** A step that a transition can go to, and the path of the step in the transition. */
export interface TransitionTarget {
  step: string;
  path: (number | string)[];
}

/** Returns the steps that a transition can go to. */
export const transitionTargets = (transition: Transition): TransitionTarget[] => {
  switch (transition.type) {
    case "step": {
      return [{ path: ["step"], step: transition.step }];
    }
    case "branch": {
      return transition.branches.flatMap(({ to }, index) =>
        to.type === "step" ? [{ path: ["branches", index, "to", "step"], step: to.step }] : [],
      );
    }
    default: {
      return [];
    }
  }
};

/**
 * Returns the IDs of the steps that can run, each after the steps of the path that reaches it first.
 *
 * It skips unknown steps and steps that were already visited, so it also works on an intermediate
 * representation whose transitions are invalid.
 */
export const reachableSteps = ({ start, steps }: Intermediate): string[] => {
  const visited = new Set<string>();
  const visit = (id: string): void => {
    const step = steps[id];
    if (step === undefined || !Object.hasOwn(steps, id) || visited.has(id)) {
      return;
    }
    visited.add(id);
    for (const target of transitionTargets(step.next)) {
      visit(target.step);
    }
  };
  visit(start);
  // A Set keeps the insertion order.
  return [...visited];
};

/** Returns, for each step that can run, the steps that can run before it. */
export const earlierSteps = (
  intermediate: Intermediate,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const reachable = reachableSteps(intermediate);
  const sources = new Map<string, string[]>();
  for (const id of reachable) {
    for (const target of transitionTargets(intermediate.steps[id]?.next ?? { type: "end" })) {
      sources.set(target.step, [...(sources.get(target.step) ?? []), id]);
    }
  }

  const earlierOf = (id: string): ReadonlySet<string> => {
    const earlier = new Set<string>();
    const pending = [...(sources.get(id) ?? [])];
    for (let source = pending.pop(); source !== undefined; source = pending.pop()) {
      if (!earlier.has(source)) {
        earlier.add(source);
        pending.push(...(sources.get(source) ?? []));
      }
    }
    return earlier;
  };
  return new Map(reachable.map((id) => [id, earlierOf(id)]));
};
