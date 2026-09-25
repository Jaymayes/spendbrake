#!/usr/bin/env node
// mutation-check.mjs — does the test suite actually catch a broken guard?
//
// A green suite proves only that the code does what the tests ask. It says nothing about whether
// the tests would notice if a guard were broken. This script answers that directly: it injects one
// deliberate bug ("mutant") at a time into a scratch copy of the repo, runs the full suite, and
// records whether the suite went red (KILLED — good) or stayed green (SURVIVED — a test gap).
//
// Why this exists in this repo specifically: twice, a green suite certified the exact failure a
// gate was built to stop — a loop test asserted the $47K ping-pong was "allowed", and a regex
// alternative that matched nothing passed because its only test hit a different alternative.
//
// Safety: it never touches the working tree. Every mutant runs in a fresh copy under the OS temp
// directory, which is deleted afterwards.
//
// Usage:
//   node scripts/mutation-check.mjs              # all mutants
//   node scripts/mutation-check.mjs --only D1,A1 # a subset
//   node scripts/mutation-check.mjs --json
//
// Exit code 0 when every mutant is killed, 1 when any survive.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const COPY = ['src', 'test', 'schema.sql', 'package.json', 'tsconfig.json'];

// Each mutant: one realistic bug in one guard. `find` must match exactly once unless `all` is set,
// which the runner enforces — a mutation that silently fails to apply would report a false KILL.
const MUTANTS = [
  // ── budget gate ──────────────────────────────────────────────────────────
  { id: 'B1', file: 'src/budget-gate.ts', what: 'cap boundary: >= becomes >',
    find: 'if (spentUsd >= capUsd) return { allowed: false, reason: "cap_exceeded", spentUsd, capUsd };',
    replace: 'if (spentUsd > capUsd) return { allowed: false, reason: "cap_exceeded", spentUsd, capUsd };' },
  { id: 'B2', file: 'src/budget-gate.ts', what: 'sticky kill switch ignored',
    find: 'if (s.killSwitchHit) return { allowed: false, reason: "kill_switch", spentUsd, capUsd };',
    replace: 'if (false) return { allowed: false, reason: "kill_switch", spentUsd, capUsd };' },
  { id: 'B3', file: 'src/budget-gate.ts', what: 'store-error posture defaults to ALLOW',
    find: 'const allowed = opts.onStoreError === "allow";',
    replace: 'const allowed = opts.onStoreError !== "block";' },
  { id: 'B4', file: 'src/budget-gate.ts', what: 'unknown model priced as free',
    find: 'const rate = key ? prices[key] : DEFAULT_RATE_PER_1K;',
    replace: 'const rate = key ? prices[key] : 0;' },
  { id: 'B5', file: 'src/budget-gate.ts', what: 'invalid cap falls back to UNLIMITED',
    find: 'Number(s.capUsd) > 0 ? Number(s.capUsd) : DEFAULT_HARD_CAP_USD',
    replace: 'Number(s.capUsd) > 0 ? Number(s.capUsd) : Infinity' },

  // ── approval gate ────────────────────────────────────────────────────────
  { id: 'A1', file: 'src/approval-gate.ts', what: 'already-released item can be released again',
    find: '  if (s.status === "released") return { allowed: false, reason: "already_released" };\n',
    replace: '' },
  { id: 'A2', file: 'src/approval-gate.ts', what: 'whitespace-only releaser accepted',
    find: 'const by = (s.releasedBy ?? "").trim();',
    replace: 'const by = String(s.releasedBy ?? "");' },
  { id: 'A3', file: 'src/approval-gate.ts', what: 'retraction of LIVE content blocked',
    find: '  if (s.status === "retracted") return { allowed: false, reason: "already_retracted" };\n  return { allowed: true, reason: "ok" };',
    replace: '  if (s.status === "retracted") return { allowed: false, reason: "already_retracted" };\n  return { allowed: s.status !== "released", reason: "ok" };' },
  { id: 'A4', file: 'src/approval-gate.ts', what: 'rejected item publishable on re-release',
    find: '  if (s.status === "rejected") return { allowed: false, reason: "already_rejected" };\n',
    replace: '' },

  // ── disclosure guard: every alternative, separately ──────────────────────
  { id: 'D1', file: 'src/disclosure.ts', what: '#ad loses its word-boundary prefix (matches "word#ad")',
    find: String.raw`/(^|[\s(>#])#ad\b/i,`, replace: String.raw`/#ad\b/i,` },
  { id: 'D2', file: 'src/disclosure.ts', what: '"paid partnership" alternative deleted',
    find: String.raw`/\bpaid\s+partnership\b/i,`, replace: '' },
  { id: 'D3', file: 'src/disclosure.ts', what: '"affiliate link" alternative deleted',
    find: String.raw`/\baffiliate\s+link/i,`, replace: '' },
  { id: 'D4', file: 'src/disclosure.ts', what: '"sponsored" alternative deleted',
    find: String.raw`/\bsponsored\b/i,`, replace: '' },
  { id: 'D5', file: 'src/disclosure.ts', what: '#aigenerated alternative deleted',
    find: String.raw`/(^|[\s(>#])#aigenerated\b/i,`, replace: '' },
  { id: 'D6', file: 'src/disclosure.ts', what: '#ai alternative deleted',
    find: String.raw`/(^|[\s(>#])#ai\b/i,`, replace: '' },
  { id: 'D7', file: 'src/disclosure.ts', what: '"AI-generated" alternative deleted',
    find: String.raw`/\bAI[- ]generated\b/i,`, replace: '' },
  { id: 'D8', file: 'src/disclosure.ts', what: '"generated with/by AI" alternative deleted',
    find: String.raw`/\bgenerated\s+(?:with|by)\s+AI\b/i,`, replace: '' },
  { id: 'D9', file: 'src/disclosure.ts', what: 'whitespace-only content treated as content',
    find: 'if (!text.trim()) {', replace: 'if (!text) {' },
  { id: 'D10', file: 'src/disclosure.ts', what: 'required literals become case-sensitive',
    find: 'if (!text.toLowerCase().includes(needle.toLowerCase())) missing.push(needle);',
    replace: 'if (!text.includes(needle)) missing.push(needle);' },
  { id: 'D11', file: 'src/disclosure.ts', what: '"sponsored" pattern made case-sensitive',
    find: String.raw`/\bsponsored\b/i,`, replace: String.raw`/\bsponsored\b/,` },

  // ── reservation gate ─────────────────────────────────────────────────────
  { id: 'R1', file: 'src/reservation-gate.ts', what: 'outstanding holds ignored (the concurrency bug)',
    find: 'if (spentUsd + reservedUsd + est - capUsd > EPSILON_USD) {',
    replace: 'if (spentUsd + est - capUsd > EPSILON_USD) {' },
  { id: 'R2', file: 'src/reservation-gate.ts', what: 'unreadable actual cost settles at $0',
    find: 'const accrueUsd = actualUnknown ? hold : raw;', replace: 'const accrueUsd = actualUnknown ? 0 : raw;' },
  { id: 'R3', file: 'src/reservation-gate.ts', what: 'unpriceable model reserved at $0',
    find: 'if (rate === undefined) return Number.POSITIVE_INFINITY;', replace: 'if (rate === undefined) return 0;' },
  { id: 'R4', file: 'src/reservation-gate.ts', what: 'float tolerance removed',
    find: 'const EPSILON_USD = 1e-9;', replace: 'const EPSILON_USD = 0;' },
  { id: 'R5', file: 'src/reservation-gate.ts', what: 'kill switch ignored by reservations',
    find: 'if (s.killSwitchHit) return { allowed: false, reason: "kill_switch", reserveUsd: 0, ...base };',
    replace: 'if (false) return { allowed: false, reason: "kill_switch", reserveUsd: 0, ...base };' },
  { id: 'R6', file: 'src/reservation-gate.ts', what: 'spend-at-cap check removed',
    find: 'if (spentUsd >= capUsd) return { allowed: false, reason: "cap_exceeded", reserveUsd: 0, ...base };',
    replace: 'if (false) return { allowed: false, reason: "cap_exceeded", reserveUsd: 0, ...base };' },
  { id: 'R7', file: 'src/reservation-gate.ts', what: 'invalid estimate accepted',
    find: 'if (typeof estimateUsd !== "number" || !Number.isFinite(est) || est < 0) {', replace: 'if (false) {' },

  // ── loop breaker ─────────────────────────────────────────────────────────
  { id: 'L1', file: 'src/loop-gate.ts', what: 'iteration boundary: >= becomes >',
    find: 'if (iteration >= maxIterations) {', replace: 'if (iteration > maxIterations) {' },
  { id: 'L2', file: 'src/loop-gate.ts', what: 'oscillation detector disabled',
    find: 'if (trailingRoundTrips(s.recentActions) >= maxRepeats) {', replace: 'if (false) {' },
  { id: 'L3', file: 'src/loop-gate.ts', what: 'corrupt counter reads as zero',
    find: 'if (typeof s.iteration !== "number" || !Number.isFinite(raw)) {', replace: 'if (false) {' },
  { id: 'L4', file: 'src/loop-gate.ts', what: 'no-progress detector disabled',
    find: 'if (repeatCount >= maxRepeats) {', replace: 'if (false) {' },

  // ── storage SQL ──────────────────────────────────────────────────────────
  { id: 'S1', file: 'src/reservation-sql.ts', what: 'reserve ignores the sticky switch',
    find: 'AND w.kill_switch_hit = 0', replace: 'AND 1 = 1' },
  { id: 'S2', file: 'src/reservation-sql.ts', what: 'reserve ignores spend already at the cap',
    find: 'AND w.total_spend_usd < w.hard_cap_usd', replace: 'AND 1 = 1' },
  { id: 'S3', file: 'src/reservation-sql.ts', what: 'open holds counted across ALL windows',
    find: "WHERE r.date_string = ?2 AND r.state = 'open')", replace: "WHERE r.state = 'open')" },
  { id: 'S4', file: 'src/reservation-sql.ts', what: 'settle is not idempotent',
    find: "(SELECT date_string FROM agent_spend_reservations WHERE id = ?1 AND state = 'open')",
    replace: '(SELECT date_string FROM agent_spend_reservations WHERE id = ?1)' },
  { id: 'S5', file: 'src/reservation-sql.ts', what: 'settlement trips the switch only ABOVE the cap',
    find: 'total_spend_usd + ?2 >= hard_cap_usd', replace: 'total_spend_usd + ?2 > hard_cap_usd' },
  { id: 'S6', file: 'src/reservation-sql.ts', what: 'expiry boundary: <= becomes < (all three sites)',
    find: 'expires_at_ms <= ?1', replace: 'expires_at_ms < ?1', all: true },
  { id: 'S7', file: 'src/reservation-sql.ts', what: 'float tolerance removed from reserve admission',
    find: '<= w.hard_cap_usd + 1e-9', replace: '<= w.hard_cap_usd' },
];

// ── runner ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const only = (() => {
  const i = args.indexOf('--only');
  return i >= 0 && args[i + 1] ? new Set(args[i + 1].split(',')) : null;
})();
const asJson = args.includes('--json');

function freshCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'spendbrake-mut-'));
  for (const item of COPY) cpSync(join(REPO, item), join(dir, item), { recursive: true });
  return dir;
}

function runSuite(dir) {
  const r = spawnSync(process.execPath, ['--test', 'test/*.test.ts'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 240_000,
    windowsHide: true,
  });
  const failed = /ℹ fail (\d+)/.exec(r.stdout || '');
  return { exit: r.status, failedTests: failed ? Number(failed[1]) : null, timedOut: r.error?.code === 'ETIMEDOUT' };
}

function countOccurrences(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

// 1. The unmutated copy must pass, or every mutant would falsely read as "killed".
const baseDir = freshCopy();
const base = runSuite(baseDir);
rmSync(baseDir, { recursive: true, force: true });
if (base.exit !== 0) {
  console.log(`ABORT — the unmutated suite fails in a scratch copy (exit ${base.exit}); mutation results would be meaningless.`);
  process.exit(2);
}

const results = [];
for (const m of MUTANTS) {
  if (only && !only.has(m.id)) continue;
  const dir = freshCopy();
  try {
    const path = join(dir, m.file);
    const src = readFileSync(path, 'utf8');
    const n = countOccurrences(src, m.find);
    if (n === 0 || (!m.all && n !== 1)) {
      results.push({ ...m, verdict: 'INVALID', detail: `search text matched ${n} times — mutation not applied` });
      continue;
    }
    writeFileSync(path, m.all ? src.split(m.find).join(m.replace) : src.replace(m.find, m.replace));
    const r = runSuite(dir);
    const verdict = r.timedOut ? 'TIMEOUT' : r.exit === 0 ? 'SURVIVED' : 'KILLED';
    results.push({ ...m, verdict, detail: verdict === 'KILLED' ? `${r.failedTests ?? '?'} test(s) failed` : '' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const killed = results.filter((r) => r.verdict === 'KILLED').length;
const survived = results.filter((r) => r.verdict === 'SURVIVED');
const invalid = results.filter((r) => r.verdict === 'INVALID' || r.verdict === 'TIMEOUT');
const scored = killed + survived.length;

if (asJson) {
  console.log(JSON.stringify({ killed, survived: survived.length, invalid: invalid.length, results }, null, 2));
} else {
  for (const r of results) {
    const mark = r.verdict === 'KILLED' ? 'KILLED  ' : r.verdict === 'SURVIVED' ? 'SURVIVED' : r.verdict.padEnd(8);
    console.log(`${mark} ${r.id.padEnd(4)} ${r.what}${r.detail ? `  (${r.detail})` : ''}`);
  }
  console.log(
    `\nmutation score: ${killed}/${scored} killed (${scored ? Math.round((killed / scored) * 100) : 0}%)` +
      (invalid.length ? ` · ${invalid.length} invalid` : ''),
  );
  if (survived.length) console.log(`surviving mutants are test gaps: ${survived.map((r) => r.id).join(', ')}`);
}
process.exit(survived.length || invalid.length ? 1 : 0);
