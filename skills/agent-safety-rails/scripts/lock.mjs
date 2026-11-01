#!/usr/bin/env node
/**
 * lock — exclusive resource locks shared by concurrent agent sessions on one machine.
 *
 *   node lock.mjs lock    <resource> --owner <id> [--ttl-min 240] [--note "why"] [--take-expired]
 *   node lock.mjs unlock  <resource> --owner <id>
 *   node lock.mjs check   <resource> --owner <id>     exit 0 = you may act, 2 = someone else holds it
 *   node lock.mjs status  [<resource>]
 *
 * Resources are names you choose: `main`, `deploy:prod`, `db:prod-writes`, `shared-checkout`.
 * Lock files live in $AGENT_LOCK_DIR, default ~/.claude/coordination/locks. Creation is atomic (O_EXCL), so two
 * sessions racing for one free resource cannot both win. Exit codes: 0 ok, 2 refused/held, 1 usage or I/O error.
 *
 * A lock is a courtesy between cooperating sessions, not a security boundary: anything that can write the
 * directory can delete a lock. Pair it with real gates (check-deploy-clean, an ancestry check before push).
 */
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { slug, parseLock, decideUnlock, decideCheck, isExpired } from './lib/locks.mjs';
import { readLock, acquire } from './lib/lock-store.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const flag = (name) => rest.includes(name);
const VALUE_OPTS = new Set(['--owner', '--ttl-min', '--note']);
const positional = rest.filter((a, i) => !a.startsWith('--') && !VALUE_OPTS.has(rest[i - 1]));
const resource = positional[0];
const owner = opt('--owner');
const dir = process.env.AGENT_LOCK_DIR || join(homedir(), '.claude', 'coordination', 'locks');

const usage = () => { console.error('usage: lock.mjs lock|unlock|check <resource> --owner <id> [--ttl-min N] [--note "…"] [--take-expired] | status [<resource>]'); process.exit(1); };
const fileOf = (r) => join(dir, `${slug(r)}.lock.json`);
const read = (r) => readLock(fileOf(r));

try {
  if (cmd === 'status') {
    mkdirSync(dir, { recursive: true });
    const now = new Date();
    const files = readdirSync(dir).filter((f) => f.endsWith('.lock.json')).filter((f) => !resource || f === `${slug(resource)}.lock.json`);
    if (!files.length) { console.log(resource ? `${resource}: free` : 'no locks held'); process.exit(0); }
    for (const f of files.sort()) {
      const l = parseLock(readFileSync(join(dir, f), 'utf8'));
      console.log(`${l.resource.padEnd(24)} ${l.owner.padEnd(28)} until ${l.expiresAt}${isExpired(l, now) ? '  EXPIRED' : ''}${l.note ? `  — ${l.note}` : ''}`);
    }
    process.exit(0);
  }
  if (!['lock', 'unlock', 'check'].includes(cmd) || !resource) usage();
  mkdirSync(dir, { recursive: true });
  const now = new Date();

  if (cmd === 'lock') {
    const ttl = opt('--ttl-min');
    const r = acquire(fileOf(resource), { resource, owner, ttlMin: ttl === undefined ? undefined : Number(ttl), note: opt('--note'), takeExpired: flag('--take-expired') }, now);
    if (!r.ok) { console.error(`LOCK ${resource} refused: ${r.reason}`); process.exit(2); }
    console.log(`LOCK ${resource} (held now by ${owner}, until ${r.lock.expiresAt}): ${r.reason}`);
    process.exit(0);
  }
  const existing = read(resource);
  if (cmd === 'check') {
    const d = decideCheck(existing, owner, now);
    console.log(`${resource}: ${d.reason}`);
    process.exit(d.ok ? 0 : 2);
  }
  if (cmd === 'unlock') {
    const d = decideUnlock(existing, owner);
    if (d.action === 'remove') rmSync(fileOf(resource), { force: true });
    console.log(`UNLOCK ${resource}: ${d.reason}`);
    process.exit(d.action === 'refuse' ? 2 : 0);
  }
} catch (e) {
  console.error(`lock: ${e.message}`);
  process.exit(1);
}
