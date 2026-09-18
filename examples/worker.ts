// Reference wiring on Cloudflare Workers + D1 + KV.
// Shows the things the pure functions cannot do for you: read/write the spend window atomically,
// invalidate the cached decision on accrual, and hold/settle/expire reservations in D1 batches.

import {
  DEFAULT_HARD_CAP_USD,
  estimateCostUsd,
  evaluateBudget,
  evaluateBudgetOnStoreError,
  checkDisclosures,
  estimateMaxCostUsd,
  evaluateRelease,
  RESERVATION_SQL,
  settleReservation,
} from "spendbrake";

interface Env {
  DB: D1Database;
  CACHE?: KVNamespace;
}

const CACHE_KEY = "control-plane:budget";
const CACHE_TTL_SECONDS = 30;

/** Pre-call gate. Call this immediately before any paid inference. */
export async function budgetGate(env: Env) {
  try {
    const cached = await env.CACHE?.get(CACHE_KEY, "json").catch(() => null);
    if (cached && typeof (cached as any).allowed === "boolean") return cached as any;

    const row = await env.DB.prepare(
      `SELECT total_spend_usd, hard_cap_usd, kill_switch_hit
         FROM agent_spend_windows
        WHERE date_string = strftime('%Y-%m-%d','now')`,
    ).first<{ total_spend_usd: number; hard_cap_usd: number; kill_switch_hit: number }>();

    // No row yet today means no spend yet today — not an error.
    const decision = row
      ? evaluateBudget({
          spentUsd: Number(row.total_spend_usd) || 0,
          capUsd: Number(row.hard_cap_usd) || DEFAULT_HARD_CAP_USD,
          killSwitchHit: row.kill_switch_hit === 1,
        })
      : evaluateBudget({ spentUsd: 0, capUsd: DEFAULT_HARD_CAP_USD });

    await env.CACHE?.put(CACHE_KEY, JSON.stringify(decision), {
      expirationTtl: CACHE_TTL_SECONDS,
    }).catch(() => {});

    return decision;
  } catch (err) {
    console.error("[control-plane] spend store unreadable:", err);
    // Failure posture is an explicit, greppable call — not a quiet `return { allowed: true }`.
    return evaluateBudgetOnStoreError(DEFAULT_HARD_CAP_USD, { onStoreError: "block" });
  }
}

/** Post-call accrual. The sticky switch flips inside the same statement as the accrual. */
export async function budgetAccrue(env: Env, model: string, tokens: number) {
  const costUsd = estimateCostUsd(model, tokens);
  if (!(costUsd > 0)) return; // zero-cost models accrue nothing

  await env.DB.prepare(
    `INSERT INTO agent_spend_windows (date_string, total_spend_usd, hard_cap_usd, call_count)
       VALUES (strftime('%Y-%m-%d','now'), ?1, ?2, 1)
     ON CONFLICT(date_string) DO UPDATE SET
       total_spend_usd = total_spend_usd + ?1,
       call_count      = call_count + 1,
       kill_switch_hit = CASE WHEN total_spend_usd + ?1 >= hard_cap_usd
                              THEN 1 ELSE kill_switch_hit END,
       updated_at      = datetime('now')`,
  )
    // hard_cap_usd written EXPLICITLY so the code constant is the source of truth.
    // A cap set deliberately for a given day is preserved on conflict — an accrual must not
    // overwrite it mid-window.
    .bind(costUsd, DEFAULT_HARD_CAP_USD)
    .run();

  // Invalidate on accrual, not just on TTL. Otherwise a tripped switch stays invisible for
  // the length of the TTL — exactly the window in which spend is running hottest.
  await env.CACHE?.delete(CACHE_KEY).catch(() => {});
}

// ── Reservations ────────────────────────────────────────────────────────────
// With concurrent calls, use these instead of budgetGate + budgetAccrue. The reserve statement is
// the gate: it counts every open hold against the cap inside one atomic statement, so there is no
// read-then-write window and nothing to cache.

const HOLD_TTL_MS = 5 * 60_000;

/** Hold a call's worst case before making it. Returns the hold, or null when refused. */
export async function reserveCall(
  env: Env,
  id: string,
  model: string,
  promptTokens: number,
  maxOutputTokens: number,
): Promise<{ id: string; holdUsd: number } | null> {
  const holdUsd = estimateMaxCostUsd(model, promptTokens, maxOutputTokens);
  // Unpriceable model or unbounded output: Infinity. Refuse without touching storage.
  if (!Number.isFinite(holdUsd)) return null;

  const [, reserved] = await env.DB.batch([
    env.DB.prepare(RESERVATION_SQL.ensureWindow).bind(windowKey(), DEFAULT_HARD_CAP_USD),
    env.DB.prepare(RESERVATION_SQL.reserve).bind(id, windowKey(), holdUsd, Date.now() + HOLD_TTL_MS),
  ]);
  return reserved.meta.changes === 1 ? { id, holdUsd } : null;
}

/**
 * Settle after the call. Pass the provider-reported cost, or null if it could not be read — the
 * hold is then charged, never zero. Safe to retry: a second settle for the same id changes nothing.
 */
export async function settleCall(env: Env, hold: { id: string; holdUsd: number }, actualUsd: number | null) {
  const s = settleReservation({ reservedUsd: 0, holdUsd: hold.holdUsd, actualUsd });
  if (s.overrun) console.warn("[control-plane] call cost more than its worst case:", hold.id);
  await env.DB.batch([
    env.DB.prepare(RESERVATION_SQL.accrueSettled).bind(hold.id, s.accrueUsd),
    env.DB.prepare(RESERVATION_SQL.markSettled).bind(hold.id, s.actualUnknown ? null : s.accrueUsd),
  ]);
  await env.CACHE?.delete(CACHE_KEY).catch(() => {});
}

/** Cron: charge holds whose call never settled (crash, timeout). Charged, not refunded. */
export async function expireStaleHolds(env: Env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(RESERVATION_SQL.expireAccrue).bind(now),
    env.DB.prepare(RESERVATION_SQL.expireMark).bind(now),
  ]);
  await env.CACHE?.delete(CACHE_KEY).catch(() => {});
}

function windowKey(): string {
  return new Date().toISOString().slice(0, 10); // matches strftime('%Y-%m-%d','now') in UTC
}

/** Publication path: disclosures, then human release. Both fail closed. */
export async function publish(env: Env, id: number) {
  const row = await env.DB.prepare(
    `SELECT payload, status, released_by FROM agent_approval_queue WHERE id = ?`,
  )
    .bind(id)
    .first<{ payload: string; status: string; released_by: string | null }>();

  if (!row) return { published: false, reason: "not_found" };

  const disclosures = checkDisclosures(row.payload, {
    requireAd: true,
    requireAiGenerated: true,
  });
  if (!disclosures.allowed) {
    return { published: false, reason: disclosures.reason, missing: disclosures.missing };
  }

  const release = evaluateRelease({
    status: row.status as any,
    releasedBy: row.released_by,
  });
  if (!release.allowed) return { published: false, reason: release.reason };

  return { published: true, reason: "ok" };
}
