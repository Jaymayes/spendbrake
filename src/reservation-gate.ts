// reservation-gate.ts — reserve a call's worst-case cost BEFORE it runs.
//
// Pure decision functions. The caller owns storage; see schema.sql and examples/worker.ts.
//
// Why this exists alongside budget-gate.ts: evaluateBudget compares spend already recorded against
// the cap. Calls that are in flight have not been recorded yet, so N concurrent calls can each read
// "under the cap" and collectively overshoot it. The sticky kill switch stops the NEXT call after the
// overshoot; a reservation stops the overshoot. Each call holds its worst case against the cap until
// it settles, and outstanding holds count as spent for everyone else's admission check.
//
// Load-bearing choices:
//   1. An estimate that cannot be trusted (NaN, negative, infinite, missing) is REFUSED, not treated
//      as zero. An unbounded output budget has no worst case, so it cannot be reserved.
//   2. Negative counters are clamped to zero — a corrupt value must not buy headroom.
//   3. A non-positive cap falls back to DEFAULT_HARD_CAP_USD, never to unlimited (same rule as the
//      budget gate).
//   4. Settlement accrues the REAL cost, even when it beat the estimate, and says so. When the real
//      cost cannot be read, it accrues the HOLD, never zero: a zero would refund a call that ran.
//   5. A model with no usable price has no worst case, so it cannot be reserved. Guessing a rate, or
//      reading "no price" as free, is the fail-open path this gate exists to close.
//   6. Expiry is settlement with an unknown actual. Unlike ledger escrow, an expired hold is charged,
//      not refunded, because a call that timed out on your side may still have billed on theirs.

// `.ts` extensions so the source runs directly under Node's type stripping (as the tests do);
// tsconfig's rewriteRelativeImportExtensions turns them into `.js` in the built package.
// EPSILON_USD is shared with the budget gate so the two can never disagree about what "at the cap"
// means: 0.1 + 0.2 (0.30000000000000004) must fit a 0.3 cap, and ten 0.1s (0.9999999999999999)
// must read as reaching a 1.00 cap.
import { DEFAULT_HARD_CAP_USD, DEFAULT_PRICE_PER_1K, EPSILON_USD, lookupRatePer1K } from "./budget-gate.ts";
import type { PriceTable } from "./budget-gate.ts";

export interface ReservationState {
  /** Spend already settled in this window. */
  spentUsd: number;
  /** Sum of holds for calls that are admitted but not yet settled. */
  reservedUsd: number;
  capUsd: number;
  killSwitchHit?: boolean;
}

export type ReservationReason = "ok" | "kill_switch" | "cap_exceeded" | "would_exceed_cap" | "invalid_estimate";

export interface ReservationDecision {
  allowed: boolean;
  reason: ReservationReason;
  /** The amount to hold for this call. 0 when refused. */
  reserveUsd: number;
  spentUsd: number;
  reservedUsd: number;
  capUsd: number;
  /** cap − spent − reserved, before this call. Never negative. */
  headroomUsd: number;
}

/**
 * Decide whether a call whose worst-case cost is `estimateUsd` may be admitted, counting both
 * settled spend and every outstanding reservation against the cap.
 */
export function evaluateReservation(s: ReservationState, estimateUsd: number): ReservationDecision {
  const capUsd = Number(s.capUsd) > 0 ? Number(s.capUsd) : DEFAULT_HARD_CAP_USD;
  const spentUsd = Math.max(0, Number(s.spentUsd) || 0);
  const reservedUsd = Math.max(0, Number(s.reservedUsd) || 0);
  const headroomUsd = Math.max(0, capUsd - spentUsd - reservedUsd);
  const base = { spentUsd, reservedUsd, capUsd, headroomUsd };

  if (s.killSwitchHit) return { allowed: false, reason: "kill_switch", reserveUsd: 0, ...base };
  if (spentUsd >= capUsd - EPSILON_USD) return { allowed: false, reason: "cap_exceeded", reserveUsd: 0, ...base };

  const est = Number(estimateUsd);
  if (typeof estimateUsd !== "number" || !Number.isFinite(est) || est < 0) {
    return { allowed: false, reason: "invalid_estimate", reserveUsd: 0, ...base };
  }
  if (spentUsd + reservedUsd + est - capUsd > EPSILON_USD) {
    return { allowed: false, reason: "would_exceed_cap", reserveUsd: 0, ...base };
  }
  return { allowed: true, reason: "ok", reserveUsd: est, ...base };
}

/**
 * Worst-case cost of one call: every prompt token plus the full output allowance, priced with the
 * same table as the budget gate. Returns +Infinity — which evaluateReservation refuses — when the
 * output allowance is missing or invalid, or when the model has no usable price in the table. A call
 * you cannot bound is a call you cannot reserve. Zero-cost models (see budget-gate) return 0.
 *
 * Price the worst case with the rate your provider will actually bill for this request, including
 * long-context tiers. A table that prices a tiered request at the base rate under-reserves it.
 */
export function estimateMaxCostUsd(
  model: string,
  promptTokens: number,
  maxOutputTokens: number,
  prices: PriceTable = DEFAULT_PRICE_PER_1K,
): number {
  const out = Number(maxOutputTokens);
  if (typeof maxOutputTokens !== "number" || !Number.isFinite(out) || out < 0) {
    return Number.POSITIVE_INFINITY;
  }
  const rate = lookupRatePer1K(model, prices);
  if (rate === undefined) return Number.POSITIVE_INFINITY;
  const prompt = Math.max(0, Number(promptTokens) || 0);
  return ((prompt + out) / 1000) * rate;
}

export interface SettlementInput {
  /** Outstanding reservations for the window before this settlement. */
  reservedUsd: number;
  /** The hold this call was admitted with (ReservationDecision.reserveUsd). */
  holdUsd: number;
  /** What the call actually cost. null (or anything unreadable) when it is not known. */
  actualUsd: number | null;
}

export interface Settlement {
  /** Outstanding reservations after releasing this hold. Never negative. */
  reservedUsd: number;
  /** Amount to add to settled spend: the real cost, or the hold when the real cost is unknown. */
  accrueUsd: number;
  /** True when the actual cost was missing or unreadable and the hold was charged instead. */
  actualUnknown: boolean;
  /** True when the call cost more than its hold — the worst-case estimate was wrong. */
  overrun: boolean;
}

/**
 * Release a call's hold and accrue its cost. Pure arithmetic; apply it atomically in storage.
 * Expire a stale hold by settling it with `actualUsd: null`.
 */
export function settleReservation(i: SettlementInput): Settlement {
  const reserved = Math.max(0, Number(i.reservedUsd) || 0);
  const hold = Math.max(0, Number(i.holdUsd) || 0);
  const raw = i.actualUsd;
  const actualUnknown = typeof raw !== "number" || !Number.isFinite(raw) || raw < 0;
  const accrueUsd = actualUnknown ? hold : raw;
  return {
    reservedUsd: Math.max(0, reserved - hold),
    accrueUsd,
    actualUnknown,
    overrun: !actualUnknown && accrueUsd - hold > EPSILON_USD,
  };
}
