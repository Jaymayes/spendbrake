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
  const db = fresh();
  assert.equal(reserve(db, "a", 0.1), true);
  assert.equal(reserve(db, "b", 0.1), true);
  assert.equal(reserve(db, "c", 0.12), true);
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
