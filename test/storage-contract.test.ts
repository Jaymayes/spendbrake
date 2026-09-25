import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { RESERVATION_SQL as SQL } from "../src/reservation-sql.ts";
import { settleReservation } from "../src/reservation-gate.ts";

// The storage contract, run against real SQLite. D1 is SQLite, and a D1 batch is one atomic,
// serialized transaction; `batch` below reproduces that. Statements are the exact strings the
// package exports, so the SQL the docs recommend is the SQL these tests prove.

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const DAY = "2026-09-18";
const CAP = 0.32;
const NOW = 1_000_000;
const TTL = 60_000;

type Params = (string | number | null)[];

function fresh(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return db;
}

/** Run statements as one transaction and return each statement's row-change count. */
function batch(db: DatabaseSync, stmts: [string, Params][]): number[] {
  db.exec("BEGIN");
  try {
    const changes = stmts.map(([sql, p]) => Number(db.prepare(sql).run(...p).changes));
    db.exec("COMMIT");
    return changes;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function reserve(db: DatabaseSync, id: string, holdUsd: number, now = NOW, cap = CAP): boolean {
  const [, inserted] = batch(db, [
    [SQL.ensureWindow, [DAY, cap]],
    [SQL.reserve, [id, DAY, holdUsd, now + TTL]],
  ]);
  return inserted === 1;
}

function holdOf(db: DatabaseSync, id: string): number {
  const row = db.prepare("SELECT hold_usd FROM agent_spend_reservations WHERE id = ?").get(id) as
    | { hold_usd: number }
    | undefined;
  return row ? row.hold_usd : 0;
}

function settle(db: DatabaseSync, id: string, actualUsd: number | null): void {
  const s = settleReservation({ reservedUsd: 0, holdUsd: holdOf(db, id), actualUsd: actualUsd as number });
  batch(db, [
    [SQL.accrueSettled, [id, s.accrueUsd]],
    [SQL.markSettled, [id, s.actualUnknown ? null : s.accrueUsd]],
  ]);
}

function windowRow(db: DatabaseSync) {
  return db.prepare("SELECT * FROM agent_spend_windows WHERE date_string = ?").get(DAY) as {
    total_spend_usd: number;
    hard_cap_usd: number;
    kill_switch_hit: number;
    call_count: number;
  };
}

function openHolds(db: DatabaseSync): number {
  const r = db
    .prepare("SELECT COALESCE(SUM(hold_usd), 0) AS s FROM agent_spend_reservations WHERE state = 'open'")
    .get() as { s: number };
  return r.s;
}

test("concurrent holds are refused once they would oversubscribe the cap, before anything is spent", () => {
  const db = fresh();
  assert.equal(reserve(db, "a", 0.1), true);
  assert.equal(reserve(db, "b", 0.1), true);
  assert.equal(reserve(db, "c", 0.1), true);
  assert.equal(reserve(db, "d", 0.1), false, "0.4 of holds against a 0.32 cap must not all be admitted");
  assert.equal(windowRow(db).total_spend_usd, 0, "nothing has been spent yet — only holds");
});

test("a hold that lands exactly on the cap is admitted despite floating-point drift", () => {
  // 0.1 + 0.2 sums to 0.30000000000000004 in SQLite's REAL arithmetic, just OVER a 0.3 cap; the
  // `+ 1e-9` in the reserve statement is what admits it. (0.1 + 0.1 + 0.12 sums to exactly 0.32, so
  // an earlier version of this test never exercised the tolerance.)
  const db = fresh();
  assert.equal(reserve(db, "a", 0.1, NOW, 0.3), true);
  assert.equal(reserve(db, "b", 0.2, NOW, 0.3), true);
});

test("the sticky kill switch refuses a reservation even with headroom", () => {
  const db = fresh();
  reserve(db, "a", 0.01);
  db.prepare("UPDATE agent_spend_windows SET kill_switch_hit = 1").run();
  assert.equal(reserve(db, "b", 0.01), false);
});

test("spend already at the cap refuses even a zero-cost hold", () => {
  const db = fresh();
  reserve(db, "a", 0.32);
  settle(db, "a", 0.32);
  db.prepare("UPDATE agent_spend_windows SET kill_switch_hit = 0").run(); // isolate the spend check
  assert.equal(reserve(db, "b", 0), false);
});

test("no window row means no reservation — the reserve statement fails closed on its own", () => {
  const db = fresh();
  const r = db.prepare(SQL.reserve).run("x", DAY, 0.01, NOW + TTL);
  assert.equal(Number(r.changes), 0);
});

test("ensureWindow never overwrites a cap already set for the window", () => {
  const db = fresh();
  reserve(db, "a", 0.01, NOW, 0.32);
  reserve(db, "b", 0.01, NOW, 5);
  assert.equal(windowRow(db).hard_cap_usd, 0.32);
});

test("settling releases the hold and accrues the real cost", () => {
  const db = fresh();
  reserve(db, "a", 0.1);
  settle(db, "a", 0.04);
  assert.equal(openHolds(db), 0);
  assert.ok(Math.abs(windowRow(db).total_spend_usd - 0.04) < 1e-12);
  assert.equal(windowRow(db).call_count, 1);
});

test("settlement is idempotent — a replayed settle accrues nothing", () => {
  const db = fresh();
  reserve(db, "a", 0.1);
  settle(db, "a", 0.04);
  settle(db, "a", 0.04);
  assert.ok(Math.abs(windowRow(db).total_spend_usd - 0.04) < 1e-12);
  assert.equal(windowRow(db).call_count, 1);
});

test("an unreadable actual cost accrues the hold, not zero", () => {
  const db = fresh();
  reserve(db, "a", 0.1);
  settle(db, "a", Number.NaN);
  assert.ok(Math.abs(windowRow(db).total_spend_usd - 0.1) < 1e-12);
  const row = db.prepare("SELECT state, actual_usd FROM agent_spend_reservations WHERE id = 'a'").get() as {
    state: string;
    actual_usd: number | null;
  };
  assert.equal(row.state, "settled");
  assert.equal(row.actual_usd, null, "the record says the actual was unknown instead of inventing one");
});

test("a settlement that reaches the cap trips the sticky switch in the same statement", () => {
  const db = fresh();
  reserve(db, "a", 0.32);
  settle(db, "a", 0.32);
  assert.equal(windowRow(db).kill_switch_hit, 1);
  assert.equal(reserve(db, "b", 0.001), false);
});

test("expired holds settle as spent, and a late settle for them is a no-op", () => {
  const db = fresh();
  reserve(db, "stale", 0.1, NOW);
  reserve(db, "live", 0.05, NOW + 10 * TTL);
  const later = NOW + 2 * TTL;
  batch(db, [
    [SQL.expireAccrue, [later]],
    [SQL.expireMark, [later]],
  ]);
  assert.ok(Math.abs(windowRow(db).total_spend_usd - 0.1) < 1e-12, "the stale hold is charged at its worst case");
  assert.ok(Math.abs(openHolds(db) - 0.05) < 1e-12, "an unexpired hold is untouched");
  settle(db, "stale", 0.01);
  assert.ok(Math.abs(windowRow(db).total_spend_usd - 0.1) < 1e-12, "a late settle cannot refund an expiry");
});

test("expiry that reaches the cap trips the sticky switch", () => {
  const db = fresh();
  reserve(db, "a", 0.32, NOW);
  const later = NOW + 2 * TTL;
  batch(db, [
    [SQL.expireAccrue, [later]],
    [SQL.expireMark, [later]],
  ]);
  assert.equal(windowRow(db).kill_switch_hit, 1);
});

test("any interleaving of reserve and settle keeps spend + open holds under the cap", () => {
  // Seeded PRNG so a failure is reproducible. Actual cost never exceeds the hold here; an overrun is
  // the one way past the cap, and it trips the sticky switch (tested above).
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let run = 0; run < 25; run++) {
    const db = fresh();
    const open: string[] = [];
    for (let step = 0; step < 60; step++) {
      if (open.length && rand() < 0.45) {
        const id = open.splice(Math.floor(rand() * open.length), 1)[0];
        settle(db, id, holdOf(db, id) * rand());
      } else {
        const id = `r${run}-${step}`;
        if (reserve(db, id, Math.round(rand() * 0.08 * 1e4) / 1e4)) open.push(id);
      }
      const w = windowRow(db);
      assert.ok(
        w.total_spend_usd + openHolds(db) <= CAP + 1e-9,
        `run ${run} step ${step}: ${w.total_spend_usd} + ${openHolds(db)} > ${CAP}`,
      );
    }
  }
});

// ── QA edge cases (2026-09-24) ──────────────────────────────────────────────
// Each of these was added because a deliberate bug in the SQL survived the suite above
// (scripts/mutation-check.mjs), or because the behaviour was undocumented.

function reserveOn(db: DatabaseSync, day: string, id: string, holdUsd: number, cap = CAP): boolean {
  const [, inserted] = batch(db, [
    [SQL.ensureWindow, [day, cap]],
    [SQL.reserve, [id, day, holdUsd, NOW + TTL]],
  ]);
  return inserted === 1;
}

test("holds in one window never count against another window's cap", () => {
  // Killed mutant S3: without the date filter, yesterday's open hold blocks today's first call.
  const db = fresh();
  assert.equal(reserveOn(db, "2026-09-18", "yesterday", 0.3), true);
  assert.equal(reserveOn(db, "2026-09-19", "today", 0.3), true, "a fresh window must start with full headroom");
});

test("a hold expires at exactly its expiry instant, not one tick after", () => {
  // Killed mutant S6: with `<` instead of `<=`, a hold at its expiry instant is neither live nor charged.
  const db = fresh();
  reserve(db, "edge", 0.1, NOW);
  const exactly = NOW + TTL;
  batch(db, [
    [SQL.expireAccrue, [exactly]],
    [SQL.expireMark, [exactly]],
  ]);
  assert.ok(Math.abs(windowRow(db).total_spend_usd - 0.1) < 1e-12);
  assert.equal(openHolds(db), 0);
});

test("a retried reserve with the same id throws and leaves exactly one hold", () => {
  // Undocumented: reserve is NOT idempotent. A retry does not double-count — it fails loudly —
  // so a caller that retries must catch the constraint error rather than assume success.
  const db = fresh();
  assert.equal(reserve(db, "dup", 0.1), true);
  assert.throws(() => reserve(db, "dup", 0.1));
  assert.ok(Math.abs(openHolds(db) - 0.1) < 1e-12, "the failed retry must not add a second hold");
});

test("settling an id that was never reserved is a no-op, not an error", () => {
  const db = fresh();
  reserve(db, "real", 0.1);
  assert.doesNotThrow(() => settle(db, "ghost", 0.05));
  assert.equal(windowRow(db).total_spend_usd, 0);
  assert.equal(windowRow(db).call_count, 0);
});

test("a negative hold is rejected by the schema, not silently buying headroom", () => {
  const db = fresh();
  assert.throws(() => reserve(db, "neg", -0.5));
  assert.equal(openHolds(db), 0);
});

// Fixed DEFECT-7: ten $0.10 settles sum to 0.9999999999999999, so a bare `>= hard_cap_usd` trip
// never fired at the default $1.00 cap.
test("spending exactly the cap in small calls trips the sticky switch", () => {
  const db = fresh();
  for (let i = 0; i < 10; i++) {
    assert.equal(reserve(db, `c${i}`, 0.1, NOW, 1), true);
    settle(db, `c${i}`, 0.1);
  }
  assert.ok(windowRow(db).total_spend_usd < 1, "precondition: the stored total really is just under 1.00");
  assert.equal(windowRow(db).kill_switch_hit, 1, `spent ${windowRow(db).total_spend_usd} of 1.00`);
  assert.equal(reserve(db, "eleventh", 0.001, NOW, 1), false, "and the next call is refused");
});

test("expiry that lands exactly on the cap trips the switch despite drift", () => {
  // SQLite's SUM() uses compensated summation, so ten 0.1 holds expiring together sum to exactly
  // 1.0 and never drift. Drift comes from INCREMENTAL accrual: nine settles leave the stored total at
  // 0.8999999999999999, and one expiring 0.1 hold then lands at 0.9999999999999999. (An earlier draft
  // of this test expired all ten at once and passed before the fix — it proved nothing.)
  const db = fresh();
  for (let i = 0; i < 9; i++) {
    reserve(db, `s${i}`, 0.1, NOW, 1);
    settle(db, `s${i}`, 0.1);
  }
  reserve(db, "stale", 0.1, NOW, 1);
  const later = NOW + 2 * TTL;
  batch(db, [
    [SQL.expireAccrue, [later]],
    [SQL.expireMark, [later]],
  ]);
  assert.ok(windowRow(db).total_spend_usd < 1, `precondition: total ${windowRow(db).total_spend_usd} drifted under 1.00`);
  assert.equal(windowRow(db).kill_switch_hit, 1, `expired total ${windowRow(db).total_spend_usd} of 1.00`);
});

test("drifted at-cap spend refuses even a zero-cost hold, with the switch cleared", () => {
  // Isolates reserve's own spend-at-cap tolerance: the sticky switch would otherwise mask it.
  const db = fresh();
  for (let i = 0; i < 10; i++) {
    reserve(db, `c${i}`, 0.1, NOW, 1);
    settle(db, `c${i}`, 0.1);
  }
  db.prepare("UPDATE agent_spend_windows SET kill_switch_hit = 0").run();
  assert.ok(windowRow(db).total_spend_usd < 1, "precondition: stored total drifted under 1.00");
  assert.equal(reserve(db, "zero", 0, NOW, 1), false);
});
