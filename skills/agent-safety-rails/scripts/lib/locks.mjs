// locks.mjs — the decisions scripts/lock.mjs makes, kept pure so every rule is testable without a filesystem.
//
// WHY. Several agent sessions working one repo will, sooner or later, deploy over each other's canary, merge into
// a branch another session is mid-gate on, or fix the same defect twice. A LOCK is a file that says "I hold this
// resource now", with an owner and an expiry, that every session checks before touching the resource.
//
// Rules (each one learned the hard way):
//   - A lock is held or not. "I'll lock it after this" is not a lock.
//   - Only the owner unlocks. A peer asking you to unlock is a request, not an unlock.
//   - An expired lock is NOT free. Its holder may have restarted and still be mid-work. Ask it first; only then
//     take it over explicitly (--take-expired), which is recorded.
//   - Every doubt (unreadable file, missing owner, bad JSON) resolves to "held".

export const DEFAULT_TTL_MIN = 240;

/** A resource name → a safe file stem. `worker:prod` and `worker/prod` both become `worker_prod`. */
export function slug(resource) {
  const s = String(resource || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!s || s === '.' || s === '..') throw new Error(`invalid resource name: ${JSON.stringify(resource)}`);
  return s;
}

/** Parse a lock file's text. Anything unreadable is reported as held by "unknown" and never expires. */
export function parseLock(text) {
  try {
    const l = JSON.parse(text);
    if (l && typeof l.owner === 'string' && l.owner && typeof l.expiresAt === 'string') return l;
  } catch { /* fall through */ }
  return { owner: 'unknown', resource: '?', expiresAt: '9999-12-31T00:00:00.000Z', note: 'unreadable lock file: treated as held' };
}

export const isExpired = (lock, now) => Date.parse(lock.expiresAt) <= now.getTime();

/**
 * @param {object|null} existing  the current lock, or null if none
 * @param {{ resource: string, owner: string, ttlMin?: number, note?: string, takeExpired?: boolean }} req
 * @param {Date} now
 * @returns {{ action: 'create'|'refresh'|'takeover'|'refuse', lock?: object, reason: string }}
 */
export function decideLock(existing, req, now) {
  if (!req.owner) return { action: 'refuse', reason: 'an owner is required (your session id or lane name)' };
  const ttl = Number.isFinite(req.ttlMin) && req.ttlMin > 0 ? Math.min(req.ttlMin, 24 * 60) : DEFAULT_TTL_MIN;
  const lock = {
    resource: req.resource,
    owner: req.owner,
    note: req.note || '',
    lockedAt: existing && existing.owner === req.owner ? existing.lockedAt : now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl * 60_000).toISOString(),
  };
  if (!existing) return { action: 'create', lock, reason: 'free' };
  if (existing.owner === req.owner) return { action: 'refresh', lock, reason: 'already yours; expiry extended' };
  if (!isExpired(existing, now)) return { action: 'refuse', reason: `held by ${existing.owner} until ${existing.expiresAt}${existing.note ? ` (${existing.note})` : ''}` };
  if (!req.takeExpired) {
    return { action: 'refuse', reason: `held by ${existing.owner}, EXPIRED at ${existing.expiresAt}. Ask that session first; it may have restarted mid-work. Then re-run with --take-expired.` };
  }
  return { action: 'takeover', lock: { ...lock, lockedAt: now.toISOString(), tookOverFrom: existing.owner }, reason: `took over the expired lock of ${existing.owner}` };
}

/** @returns {{ action: 'remove'|'refuse'|'noop', reason: string }} */
export function decideUnlock(existing, owner) {
  if (!existing) return { action: 'noop', reason: 'not locked' };
  if (!owner || existing.owner !== owner) return { action: 'refuse', reason: `held by ${existing.owner}; only the owner unlocks` };
  return { action: 'remove', reason: 'released' };
}

/** For a gate in front of a risky command: may `owner` act on this resource now? */
export function decideCheck(existing, owner, now) {
  if (!existing) return { ok: true, reason: 'free' };
  if (existing.owner === owner && !isExpired(existing, now)) return { ok: true, reason: 'held by you' };
  if (existing.owner === owner) return { ok: false, reason: 'your lock expired; re-lock before acting' };
  return { ok: false, reason: `held by ${existing.owner}${isExpired(existing, now) ? ' (expired: ask before taking over)' : ` until ${existing.expiresAt}`}` };
}
