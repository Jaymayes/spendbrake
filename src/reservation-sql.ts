// reservation-sql.ts — the storage half of the reservation gate, as SQL text (D1 / SQLite).
//
// No driver dependency: these are strings. Bind with numbered parameters (?1, ?2, ...) and run each
// group in ONE batch — a D1 batch is a single atomic, serialized transaction. D1 has no interactive
// BEGIN/COMMIT, so a JavaScript read-then-write is NOT atomic; the oversubscription check has to live
// inside a single guarded statement, which is what `reserve` is.
//
// The tables are in schema.sql. test/storage-contract.test.ts runs these exact strings against SQLite.
//
//   reserve:  batch [ensureWindow(?1 window, ?2 cap), reserve(?1 id, ?2 window, ?3 holdUsd, ?4 expiresAtMs)]
//             → the reserve statement changed 1 row: admitted. 0 rows: refused.
//   settle:   batch [accrueSettled(?1 id, ?2 accrueUsd), markSettled(?1 id, ?2 actualUsd | null)]
//             → idempotent: both statements match only an OPEN reservation, so a replay is a no-op.
//             Compute accrueUsd with settleReservation(), which charges the hold when the actual is
//             unreadable.
//   expire:   batch [expireAccrue(?1 nowMs), expireMark(?1 nowMs)]
//             → run on a schedule. Stale holds are charged at their worst case, not refunded.

const OPEN_HOLDS_FOR_WINDOW = `(SELECT COALESCE(SUM(r.hold_usd), 0) FROM agent_spend_reservations r
           WHERE r.date_string = ?2 AND r.state = 'open')`;

const EXPIRED_FOR_ROW = `(SELECT COALESCE(SUM(r.hold_usd), 0) FROM agent_spend_reservations r
          WHERE r.date_string = agent_spend_windows.date_string
            AND r.state = 'open' AND r.expires_at_ms <= ?1)`;

export const RESERVATION_SQL = {
  /** Create the window row with an explicit cap. Never overwrites a cap already set for the window. */
  ensureWindow: `INSERT OR IGNORE INTO agent_spend_windows (date_string, hard_cap_usd) VALUES (?1, ?2)`,

  /**
   * Admit a hold only if settled spend + every open hold + this hold fits under the cap, the switch
   * is not tripped, and spend has not already reached the cap. No window row → no admission.
   * The 1e-9 tolerance matches EPSILON_USD in the JS gates: a hold landing exactly on the cap is
   * admitted, and spend within 1e-9 below the cap already counts as having reached it.
   */
  reserve: `INSERT INTO agent_spend_reservations (id, date_string, hold_usd, expires_at_ms)
SELECT ?1, w.date_string, ?3, ?4
  FROM agent_spend_windows w
 WHERE w.date_string = ?2
   AND w.kill_switch_hit = 0
   AND w.total_spend_usd < w.hard_cap_usd - 1e-9
   AND w.total_spend_usd + ${OPEN_HOLDS_FOR_WINDOW} + ?3 <= w.hard_cap_usd + 1e-9`,

  /**
   * Accrue a settled call and trip the sticky switch in the same statement. Open reservations only.
   * The trip uses the same 1e-9 tolerance: incremental REAL accrual drifts (ten 0.1s store as
   * 0.9999999999999999), so a bare `>= hard_cap_usd` never fires on spend of exactly the cap.
   */
  accrueSettled: `UPDATE agent_spend_windows
   SET total_spend_usd = total_spend_usd + ?2,
       call_count      = call_count + 1,
       kill_switch_hit = CASE WHEN total_spend_usd + ?2 >= hard_cap_usd - 1e-9 THEN 1 ELSE kill_switch_hit END,
       updated_at      = datetime('now')
 WHERE date_string = (SELECT date_string FROM agent_spend_reservations WHERE id = ?1 AND state = 'open')`,

  /** Close the reservation. Must run AFTER accrueSettled in the same batch. */
  markSettled: `UPDATE agent_spend_reservations
   SET state = 'settled', actual_usd = ?2, settled_at = datetime('now')
 WHERE id = ?1 AND state = 'open'`,

  /** Charge every expired open hold to its window, tripping the switch if that reaches the cap. */
  expireAccrue: `UPDATE agent_spend_windows
   SET total_spend_usd = total_spend_usd + ${EXPIRED_FOR_ROW},
       kill_switch_hit = CASE WHEN total_spend_usd + ${EXPIRED_FOR_ROW} >= hard_cap_usd - 1e-9
                              THEN 1 ELSE kill_switch_hit END,
       updated_at      = datetime('now')
 WHERE date_string IN (SELECT date_string FROM agent_spend_reservations
                        WHERE state = 'open' AND expires_at_ms <= ?1)`,

  /** Close expired holds. Must run AFTER expireAccrue in the same batch. */
  expireMark: `UPDATE agent_spend_reservations
   SET state = 'expired', settled_at = datetime('now')
 WHERE state = 'open' AND expires_at_ms <= ?1`,
} as const;
