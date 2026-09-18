import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_HARD_CAP_USD } from "../src/budget-gate.ts";
import {
  estimateMaxCostUsd,
  evaluateReservation,
  settleReservation,
} from "../src/reservation-gate.ts";
import { DEFAULT_MAX_ITERATIONS, DEFAULT_MAX_IDENTICAL_REPEATS, evaluateLoop } from "../src/loop-gate.ts";

// ── reservation gate ────────────────────────────────────────────────────────
// The sticky kill switch closes the straddle window only AFTER the cap is crossed. A reservation
// closes it BEFORE: concurrent calls each reserve their worst case, so N calls that individually
// fit cannot collectively overshoot.

test("reserves the estimate when spend + outstanding reservations + estimate fit under the cap", () => {
  const d = evaluateReservation({ spentUsd: 0.1, reservedUsd: 0.05, capUsd: 0.32 }, 0.1);
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "ok");
  assert.equal(d.reserveUsd, 0.1);
});

test("outstanding reservations count against the cap — the concurrency case", () => {
  // Spend alone (0.1) is far under the cap; evaluateBudget would allow this call.
  // Two in-flight reservations already hold 0.2, so this call would overshoot.
  const d = evaluateReservation({ spentUsd: 0.1, reservedUsd: 0.2, capUsd: 0.32 }, 0.05);
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "would_exceed_cap");
  assert.equal(d.reserveUsd, 0);
});

test("landing exactly on the cap is allowed despite floating-point drift", () => {
  // 0.1 + 0.1 + 0.12 is 0.32000000000000006 in IEEE-754.
  const d = evaluateReservation({ spentUsd: 0.1, reservedUsd: 0.1, capUsd: 0.32 }, 0.12);
  assert.equal(d.allowed, true);
});

test("the sticky kill switch blocks a reservation even with headroom", () => {
  const d = evaluateReservation({ spentUsd: 0, reservedUsd: 0, capUsd: 1, killSwitchHit: true }, 0.01);
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "kill_switch");
});

test("spend already at the cap blocks even a zero-cost reservation", () => {
  const d = evaluateReservation({ spentUsd: 0.32, reservedUsd: 0, capUsd: 0.32 }, 0);
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "cap_exceeded");
});

test("an estimate that cannot be trusted fails closed", () => {
  for (const est of [Number.NaN, -0.01, Number.POSITIVE_INFINITY, undefined as unknown as number]) {
    const d = evaluateReservation({ spentUsd: 0, reservedUsd: 0, capUsd: 1 }, est);
    assert.equal(d.allowed, false, `estimate ${String(est)} must not be reserved`);
    assert.equal(d.reason, "invalid_estimate");
  }
});

test("a zero or missing cap falls back to the default, never to unlimited", () => {
  for (const capUsd of [0, -1, Number.NaN, undefined as unknown as number]) {
    const d = evaluateReservation({ spentUsd: DEFAULT_HARD_CAP_USD, reservedUsd: 0, capUsd }, 0.01);
    assert.equal(d.capUsd, DEFAULT_HARD_CAP_USD);
    assert.equal(d.allowed, false);
  }
});

test("negative spend or reservations are clamped rather than buying headroom", () => {
  const d = evaluateReservation({ spentUsd: -5, reservedUsd: -5, capUsd: 0.1 }, 0.2);
  assert.equal(d.spentUsd, 0);
  assert.equal(d.reservedUsd, 0);
  assert.equal(d.allowed, false, "a corrupt negative counter must not make room for an over-cap call");
});

test("headroom is reported so callers can log how close they are", () => {
  const d = evaluateReservation({ spentUsd: 0.1, reservedUsd: 0.1, capUsd: 0.5 }, 0.1);
  assert.ok(Math.abs(d.headroomUsd - 0.3) < 1e-9);
});

test("worst-case estimate bounds the call by prompt tokens plus max output tokens", () => {
  const worst = estimateMaxCostUsd("llama-3.3-70b", 1000, 1000);
  assert.ok(Math.abs(worst - 0.0018) < 1e-12);
});

test("an unbounded output budget cannot be estimated, so it cannot be reserved", () => {
  for (const maxOut of [undefined as unknown as number, Number.NaN, -1]) {
    const worst = estimateMaxCostUsd("llama-3.3-70b", 1000, maxOut);
    assert.equal(worst, Number.POSITIVE_INFINITY);
    const d = evaluateReservation({ spentUsd: 0, reservedUsd: 0, capUsd: 100 }, worst);
    assert.equal(d.allowed, false);
    assert.equal(d.reason, "invalid_estimate");
  }
});

test("a model with no price cannot be bounded, so it cannot be reserved", () => {
  // Pricing an unknown model at a guessed rate, or at zero, is the fail-open path: the reservation
  // looks bounded and is not. An unpriceable call is refused instead.
  assert.equal(estimateMaxCostUsd("some-new-model-9", 100, 100), Number.POSITIVE_INFINITY);
  assert.equal(estimateMaxCostUsd("", 100, 100), Number.POSITIVE_INFINITY);
  assert.equal(estimateMaxCostUsd(undefined as unknown as string, 100, 100), Number.POSITIVE_INFINITY);
  assert.equal(estimateMaxCostUsd("custom-a", 100, 100, { "custom-a": 0 }), Number.POSITIVE_INFINITY);
  assert.equal(estimateMaxCostUsd("custom-a", 100, 100, { "custom-a": Number.NaN }), Number.POSITIVE_INFINITY);
  assert.ok(Math.abs(estimateMaxCostUsd("custom-a", 500, 500, { "custom-a": 0.002 }) - 0.002) < 1e-12);
  const d = evaluateReservation(
    { spentUsd: 0, reservedUsd: 0, capUsd: 100 },
    estimateMaxCostUsd("some-new-model-9", 1, 1),
  );
  assert.equal(d.reason, "invalid_estimate");
});

test("zero-cost models reserve nothing", () => {
  assert.equal(estimateMaxCostUsd("@cf/meta/llama-3.1-8b-instruct", 5000, 5000), 0);
});

test("settling releases the hold, accrues the actual cost, and flags an overrun", () => {
  const ok = settleReservation({ reservedUsd: 0.3, holdUsd: 0.1, actualUsd: 0.04 });
  assert.ok(Math.abs(ok.reservedUsd - 0.2) < 1e-12);
  assert.equal(ok.accrueUsd, 0.04);
  assert.equal(ok.overrun, false);

  const over = settleReservation({ reservedUsd: 0.1, holdUsd: 0.1, actualUsd: 0.25 });
  assert.equal(over.reservedUsd, 0);
  assert.equal(over.accrueUsd, 0.25, "the real cost is always accrued, even when it beat the estimate");
  assert.equal(over.overrun, true);
});

test("an actual cost that cannot be read settles at the hold, never at zero", () => {
  // Accruing 0 for an unparseable usage record would refund the whole hold for a call that ran.
  const unreadable = [Number.NaN, undefined, null, -1, Number.POSITIVE_INFINITY] as unknown as number[];
  for (const actualUsd of unreadable) {
    const s = settleReservation({ reservedUsd: 0.3, holdUsd: 0.1, actualUsd });
    assert.equal(s.accrueUsd, 0.1, `actual ${String(actualUsd)} must accrue the hold`);
    assert.equal(s.actualUnknown, true);
    assert.equal(s.overrun, false);
    assert.ok(Math.abs(s.reservedUsd - 0.2) < 1e-12);
  }
  assert.equal(settleReservation({ reservedUsd: 0.1, holdUsd: 0.1, actualUsd: 0.02 }).actualUnknown, false);
});

test("an expired reservation settles as spent, not refunded", () => {
  // A timed-out call may still have billed. Expiry is settlement with an unknown actual.
  const s = settleReservation({ reservedUsd: 0.1, holdUsd: 0.1, actualUsd: null });
  assert.equal(s.accrueUsd, 0.1);
  assert.equal(s.reservedUsd, 0);
});

test("settling never drives outstanding reservations negative", () => {
  const s = settleReservation({ reservedUsd: 0.05, holdUsd: 0.1, actualUsd: 0 });
  assert.equal(s.reservedUsd, 0);
});

// ── loop breaker ────────────────────────────────────────────────────────────
// A multi-agent pipeline with no terminal predicate, no iteration counter and no per-agent cap
// can run for days. This gate is the iteration counter and the no-progress detector.

test("allows steps under the iteration limit", () => {
  const d = evaluateLoop({ iteration: 3, maxIterations: 10 });
  assert.equal(d.allowed, true);
  assert.equal(d.reason, "ok");
});

test("blocks once the iteration limit is reached", () => {
  const d = evaluateLoop({ iteration: 10, maxIterations: 10 });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "max_iterations");
});

test("a zero or missing iteration limit falls back to the default, never to unlimited", () => {
  for (const maxIterations of [0, -1, Number.NaN, undefined as unknown as number]) {
    const d = evaluateLoop({ iteration: DEFAULT_MAX_ITERATIONS, maxIterations });
    assert.equal(d.maxIterations, DEFAULT_MAX_ITERATIONS);
    assert.equal(d.allowed, false, `limit ${String(maxIterations)} must not read as unlimited`);
  }
});

test("a corrupt iteration counter fails closed instead of reading as zero", () => {
  for (const iteration of [Number.NaN, undefined as unknown as number, Number.POSITIVE_INFINITY]) {
    const d = evaluateLoop({ iteration, maxIterations: 10 });
    assert.equal(d.allowed, false, `iteration ${String(iteration)} must not reset the loop`);
    assert.equal(d.reason, "max_iterations");
  }
});

test("the same action repeated back to back is treated as no progress", () => {
  const d = evaluateLoop({
    iteration: 4,
    maxIterations: 50,
    recentActions: ["search:q=a", "verify:report-1", "verify:report-1", "verify:report-1"],
  });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "no_progress");
  assert.equal(d.repeatCount, DEFAULT_MAX_IDENTICAL_REPEATS);
});

test("repeats interleaved with varied work are progress, not a loop", () => {
  const d = evaluateLoop({
    iteration: 5,
    maxIterations: 50,
    recentActions: ["search:q=a", "verify:r1", "search:q=b", "verify:r2", "summarize:r2"],
  });
  assert.equal(d.allowed, true);
  assert.equal(d.repeatCount, 1);
});

test("two agents handing the same work back and forth is a loop — the ping-pong case", () => {
  // The shape of the $47K Analyzer <-> Verifier incident: no single action repeats back to back,
  // so a consecutive-repeat detector alone never fires.
  const d = evaluateLoop({
    iteration: 6,
    maxIterations: 50,
    recentActions: ["analyze:r1", "verify:r1", "analyze:r1", "verify:r1", "analyze:r1", "verify:r1"],
  });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "oscillation");
  assert.equal(d.repeatCount, 1);
});

test("an alternation shorter than the threshold is still allowed", () => {
  const d = evaluateLoop({
    iteration: 5,
    maxIterations: 50,
    recentActions: ["verify:r1", "analyze:r1", "verify:r1", "analyze:r1", "verify:r1"],
  });
  assert.equal(d.allowed, true, "2.5 round trips is under the default of 3");
});

test("the oscillation threshold follows maxIdenticalRepeats", () => {
  const d = evaluateLoop({ iteration: 4, maxIterations: 50, recentActions: ["a", "b", "a", "b"], maxIdenticalRepeats: 2 });
  assert.equal(d.reason, "oscillation");
});

test("the repeat threshold is configurable and a non-positive one falls back to the default", () => {
  const strict = evaluateLoop({ iteration: 2, maxIterations: 50, recentActions: ["x", "x"], maxIdenticalRepeats: 2 });
  assert.equal(strict.reason, "no_progress");
  const bogus = evaluateLoop({ iteration: 2, maxIterations: 50, recentActions: ["x", "x"], maxIdenticalRepeats: 0 });
  assert.equal(bogus.allowed, true, "0 falls back to the default of 3, it does not mean 'block everything'");
});

test("no action history is not an error", () => {
  const d = evaluateLoop({ iteration: 0, maxIterations: 5 });
  assert.equal(d.allowed, true);
  assert.equal(d.repeatCount, 0);
});
