-- Reference schema for spendbrake (D1 / SQLite).
-- Three tables: a spend window, its open reservations, and an approval queue.

-- ── Spend window ────────────────────────────────────────────────────────────
-- One row per window. `date_string` is the window key; swap the format for a
-- monthly window ('%Y-%m') if your provider's ceiling is monthly.
--
-- TRAP: do NOT give hard_cap_usd a column DEFAULT and then rely on your code
-- constant as the source of truth. New rows will silently inherit the column
-- default, so lowering the constant changes nothing. Write it explicitly on
-- insert (see examples/worker.ts). The column is NOT NULL with no default here
-- deliberately — an omitted cap should be a loud error, not a quiet ceiling.
CREATE TABLE IF NOT EXISTS agent_spend_windows (
  date_string     TEXT PRIMARY KEY,
  total_spend_usd REAL    NOT NULL DEFAULT 0,
  hard_cap_usd    REAL    NOT NULL,
  call_count      INTEGER NOT NULL DEFAULT 0,
  kill_switch_hit INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── Spend reservations ──────────────────────────────────────────────────────
-- One row per admitted call: its worst-case hold, open until settled or expired.
-- Open holds count against the cap for every other admission check, which is
-- what stops concurrent calls from overshooting before any of them is recorded.
-- Use the statements in src/reservation-sql.ts; they are tested against this
-- schema. `id` is caller-generated (e.g. crypto.randomUUID()) so a retried
-- settle can find its row and be a no-op.
CREATE TABLE IF NOT EXISTS agent_spend_reservations (
  id            TEXT    PRIMARY KEY,
  date_string   TEXT    NOT NULL REFERENCES agent_spend_windows (date_string),
  hold_usd      REAL    NOT NULL CHECK (hold_usd >= 0),
  state         TEXT    NOT NULL DEFAULT 'open'
                  CHECK (state IN ('open','settled','expired')),
  -- NULL when settled with an unreadable cost; the hold was charged instead.
  actual_usd    REAL,
  expires_at_ms INTEGER NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  settled_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_spend_reservations_open
  ON agent_spend_reservations (date_string, state);

CREATE INDEX IF NOT EXISTS idx_spend_reservations_expiry
  ON agent_spend_reservations (state, expires_at_ms);

-- ── Approval queue ──────────────────────────────────────────────────────────
-- Machine-generated items stage here as 'pending'. Publication reads
-- released_by; retraction flips status back without a redeploy.
CREATE TABLE IF NOT EXISTS agent_approval_queue (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  slug           TEXT    NOT NULL,
  payload        TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','released','rejected','retracted')),
  released_by    TEXT,
  released_at    TEXT,
  has_ad_disclosure          INTEGER NOT NULL DEFAULT 0,
  has_ai_disclosure          INTEGER NOT NULL DEFAULT 0,
  content_hash   TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_approval_queue_status
  ON agent_approval_queue (status, created_at DESC);

-- Prevents the same generated item being staged twice by a retried agent run.
-- Learn from my omission: without this, a duplicate-draft bug is invisible
-- until it is on the public site.
CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_queue_content_hash
  ON agent_approval_queue (content_hash)
  WHERE content_hash IS NOT NULL;
