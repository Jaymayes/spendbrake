// budget-gate.ts — pre-call spend ceiling for autonomous LLM inference.
//
// Pure decision functions. The caller owns storage; see schema.sql and examples/worker.ts.
//
// Design notes that are load-bearing, not stylistic:
//   1. This runs BEFORE the paid call. A gate that records spend afterward is an invoice.
//   2. The kill switch is STICKY. Concurrent calls that straddle the cap boundary would each
//      individually read as under-cap; the sticky flag is what closes that window.
//   3. A non-positive cap falls back to the default, NEVER to unlimited.

export const DEFAULT_HARD_CAP_USD = 1.0;

/** Blended USD per 1K tokens (input + output), by model-name substring. */
export type PriceTable = Record<string, number>;

/**
 * Conservative defaults. These err HIGH on purpose: the cap should trip early rather than
 * late. Override wholesale via `evaluateBudget`'s options or `estimateCostUsd`'s 3rd arg —
 * provider pricing moves and a stale table silently under-counts spend.
 */
export const DEFAULT_PRICE_PER_1K: PriceTable = {
  "llama-3.3-70b": 0.0009,
  "llama-3.1-70b": 0.0009,
  "llama-3.1-8b": 0.0001,
  "gemini-2.0-flash": 0.0004,
  "gemini-2.5-flash": 0.0006,
  "deepseek-chat": 0.0003,
  "deepseek-reasoner": 0.0022,
  "mistral-small": 0.0003,
  "mistral-large": 0.0015,
  qwen: 0.0004,
};

/** Models matching this pattern are treated as zero marginal cost (e.g. edge-hosted). */
const ZERO_COST = /^@cf\//i;

/** Unknown model → conservative $1 per 1M tokens rather than free. */
const DEFAULT_RATE_PER_1K = 0.001;

/**
 * The table's USD-per-1K rate for `model`: 0 for zero-cost models, `undefined` when the model is
 * missing or has no usable price. Callers decide what "no price" means — the budget gate accrues a
 * conservative default, the reservation gate refuses the call.
 */
export function lookupRatePer1K(model: string, prices: PriceTable = DEFAULT_PRICE_PER_1K): number | undefined {
  const m = String(model ?? "").toLowerCase();
  if (!m) return undefined;
  if (ZERO_COST.test(m)) return 0;
  const key = Object.keys(prices).find((k) => m.includes(k));
  const rate = key === undefined ? Number.NaN : Number(prices[key]);
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

/** Estimated USD for `tokens` total tokens on `model`. Unknown models are priced, not skipped. */
export function estimateCostUsd(
  model: string,
  tokens: number,
  prices: PriceTable = DEFAULT_PRICE_PER_1K,
): number {
  const t = Math.max(0, Number(tokens) || 0);
  if (t === 0) return 0;
  const m = (model ?? "").toLowerCase();
  if (!m || ZERO_COST.test(m)) return 0;
  const key = Object.keys(prices).find((k) => m.includes(k));
  const rate = key ? prices[key] : DEFAULT_RATE_PER_1K;
  return (t / 1000) * rate;
}

export interface BudgetState {
  spentUsd: number;
  capUsd: number;
  killSwitchHit?: boolean;
}

export type BudgetReason = "ok" | "kill_switch" | "cap_exceeded" | "store_unavailable";

export interface BudgetDecision {
  allowed: boolean;
  reason: BudgetReason;
  spentUsd: number;
  capUsd: number;
}

export interface BudgetOptions {
  /**
   * What to do when the spend store cannot be read. Default "block".
   *
   * "block"  — the ceiling is binding; a store outage stops inference.
   * "allow"  — the ceiling is a backstop; a store blip must not take inference down.
   *
   * There is no correct answer, only a decided one. Pick deliberately and write down why —
   * a system with different postures in different code paths has not decided.
   */
  onStoreError?: "block" | "allow";
}

/**
 * Decide whether one more paid inference is allowed.
 * BLOCKED when the sticky kill switch is set OR spend has reached the cap.
 */
export function evaluateBudget(s: BudgetState): BudgetDecision {
  const capUsd = Number(s.capUsd) > 0 ? Number(s.capUsd) : DEFAULT_HARD_CAP_USD;
  const spentUsd = Math.max(0, Number(s.spentUsd) || 0);
  if (s.killSwitchHit) return { allowed: false, reason: "kill_switch", spentUsd, capUsd };
  if (spentUsd >= capUsd) return { allowed: false, reason: "cap_exceeded", spentUsd, capUsd };
  return { allowed: true, reason: "ok", spentUsd, capUsd };
}

/**
 * Decision for the case where the spend store could not be read at all.
 * Separate function so the failure posture is a visible, greppable choice in your codebase
 * rather than a catch block that quietly returns `allowed: true`.
 */
export function evaluateBudgetOnStoreError(
  capUsd: number = DEFAULT_HARD_CAP_USD,
  opts: BudgetOptions = {},
): BudgetDecision {
  const allowed = opts.onStoreError === "allow";
  return {
    allowed,
    reason: "store_unavailable",
    spentUsd: 0,
    capUsd: Number(capUsd) > 0 ? Number(capUsd) : DEFAULT_HARD_CAP_USD,
  };
}
