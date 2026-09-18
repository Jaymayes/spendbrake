// loop-gate.ts — stop an agent loop before it runs for days.
//
// Pure decision function. The caller owns the counter and the action history.
//
// The failure it targets: a multi-agent pipeline with no terminal predicate, no iteration counter
// and no per-agent cap, where one agent keeps asking for "more analysis" and another keeps obliging.
// Nothing in the loop is wrong step by step, so nothing errors; it simply never ends.
//
// Two independent brakes:
//   1. max_iterations — a hard step count. Missing or non-positive limits fall back to the default,
//      never to unlimited. A corrupt counter (NaN, infinite, missing) fails CLOSED: resetting a
//      runaway loop's counter to zero by accident is exactly the failure this exists to prevent.
//   2. no_progress — the same action fingerprint repeated back to back N times. The caller chooses
//      the fingerprint (e.g. `${tool}:${stableHash(args)}`); identical consecutive fingerprints mean
//      the loop is spending without changing anything.

export const DEFAULT_MAX_ITERATIONS = 25;
export const DEFAULT_MAX_IDENTICAL_REPEATS = 3;

export interface LoopState {
  /** Steps already taken in this run. */
  iteration: number;
  maxIterations?: number;
  /** Most-recent-last fingerprints of the actions taken so far. */
  recentActions?: readonly string[];
  /** Consecutive identical actions that count as "no progress". */
  maxIdenticalRepeats?: number;
}

export type LoopReason = "ok" | "max_iterations" | "no_progress";

export interface LoopDecision {
  allowed: boolean;
  reason: LoopReason;
  iteration: number;
  maxIterations: number;
  /** How many times the most recent action repeats at the tail of the history. */
  repeatCount: number;
}

function positiveIntOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function trailingRepeats(actions: readonly string[] | undefined): number {
  if (!actions || actions.length === 0) return 0;
  const last = actions[actions.length - 1];
  let count = 0;
  for (let i = actions.length - 1; i >= 0 && actions[i] === last; i--) count++;
  return count;
}

/** Decide whether the agent may take one more step. */
export function evaluateLoop(s: LoopState): LoopDecision {
  const maxIterations = positiveIntOr(s.maxIterations, DEFAULT_MAX_ITERATIONS);
  const maxRepeats = positiveIntOr(s.maxIdenticalRepeats, DEFAULT_MAX_IDENTICAL_REPEATS);
  const repeatCount = trailingRepeats(s.recentActions);

  const raw = Number(s.iteration);
  if (typeof s.iteration !== "number" || !Number.isFinite(raw)) {
    return { allowed: false, reason: "max_iterations", iteration: maxIterations, maxIterations, repeatCount };
  }
  const iteration = Math.max(0, Math.floor(raw));

  if (iteration >= maxIterations) {
    return { allowed: false, reason: "max_iterations", iteration, maxIterations, repeatCount };
  }
  if (repeatCount >= maxRepeats) {
    return { allowed: false, reason: "no_progress", iteration, maxIterations, repeatCount };
  }
  return { allowed: true, reason: "ok", iteration, maxIterations, repeatCount };
}
