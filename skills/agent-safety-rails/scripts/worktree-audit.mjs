#!/usr/bin/env node
// Read-only worktree audit: classifies every registered worktree of the current repo and SUGGESTS cleanup commands.
// It never removes, prunes or edits anything (--fetch only refreshes remote-tracking refs).
//
//   node worktree-audit.mjs [--json] [--fetch] [--base origin/main] [--keep-file <path>]
//
// Protected worktrees come from a `.worktree-keep` file (default: at the main worktree's root; one path per line,
// "# reason" optional) and from any Claude Code settings file that references a worktree path (a hook running from
// it). Override the settings files read with WORKTREE_AUDIT_SETTINGS="a.json;b.json" ("" reads none).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseWorktreeList, parseKeepFile, protectReferenced, classify, suggest, REMOVABLE, STATES } from './lib/worktree-audit.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const json = args.includes('--json');
const base = opt('--base', 'origin/main');

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
const tryGit = (cwd, ...a) => { try { return git(cwd, ...a); } catch { return null; } };

const cwd = process.cwd();
if (tryGit(cwd, 'rev-parse', '--git-dir') === null) { console.error('worktree-audit: not inside a git repository.'); process.exit(2); }
if (args.includes('--fetch')) git(cwd, 'fetch', '-q', '--prune');
const hasBase = tryGit(cwd, 'rev-parse', '--verify', '-q', base) !== null;

const worktrees = parseWorktreeList(git(cwd, 'worktree', 'list', '--porcelain'));
const keepPath = opt('--keep-file', join(worktrees[0]?.path || cwd, '.worktree-keep'));
let protectedMap = new Map();
if (existsSync(keepPath)) protectedMap = parseKeepFile(readFileSync(keepPath, 'utf8'));
else if (!json) console.log(`(no keep file at ${keepPath}; only the main worktree and hook-referenced paths are protected)`);

const settingsFiles = process.env.WORKTREE_AUDIT_SETTINGS !== undefined
  ? process.env.WORKTREE_AUDIT_SETTINGS.split(';').filter(Boolean)
  : [join(homedir(), '.claude', 'settings.json'), join(homedir(), '.claude', 'settings.local.json')];
for (const f of settingsFiles) {
  try { protectReferenced(protectedMap, worktrees, f.replace(/\\/g, '/').replace(homedir().replace(/\\/g, '/'), '~'), readFileSync(f, 'utf8')); } catch { /* absent */ }
}

// branch → upstream tracking, once for the whole repo.
const gone = new Set();
for (const l of (tryGit(cwd, 'for-each-ref', '--format=%(refname:short)|%(upstream)|%(upstream:track)', 'refs/heads') || '').split('\n')) {
  const [b, up, track] = l.split('|');
  if (b && up && /\[gone\]/.test(track || '')) gone.add(b);
}

const rows = [];
for (const wt of worktrees) {
  const exists = existsSync(wt.path);
  const status = exists ? tryGit(wt.path, 'status', '--porcelain') : '';
  const facts = {
    exists,
    dirty: status === null ? null : status.split('\n').filter(Boolean).length,
    pushed: !!(wt.head && (tryGit(cwd, 'branch', '-r', '--contains', wt.head) || '').trim()),
    merged: !!(wt.head && hasBase && tryGit(cwd, 'merge-base', '--is-ancestor', wt.head, base) !== null),
    upstreamGone: !!(wt.branch && gone.has(wt.branch)),
  };
  const { state, reason } = classify(wt, facts, protectedMap);
  rows.push({ path: wt.path, branch: wt.branch || (wt.detached ? `(detached ${String(wt.head).slice(0, 8)})` : ''), state, reason, suggest: suggest(wt, state) });
}

if (json) {
  console.log(JSON.stringify({ base, baseFound: hasBase, worktrees: rows }, null, 2));
  process.exit(0);
}

const counts = Object.fromEntries(STATES.map((s) => [s, rows.filter((r) => r.state === s).length]));
console.log(`worktree-audit: ${rows.length} worktree(s) — ` + STATES.filter((s) => counts[s]).map((s) => `${s} ${counts[s]}`).join(', '));
if (!hasBase) console.log(`  (no ${base} ref — nothing can be judged merged)`);
const w = Math.max(...rows.map((r) => r.path.length), 4);
for (const s of STATES) for (const r of rows.filter((x) => x.state === s)) {
  console.log(`  ${r.state.padEnd(19)} ${r.path.padEnd(w)}  ${r.branch}  — ${r.reason}`);
}
const removable = rows.filter((r) => REMOVABLE.has(r.state));
if (removable.length) {
  console.log('\nSuggested commands (NOT run; check that no open session is working in a worktree before removing it):');
  for (const c of new Set(removable.flatMap((r) => r.suggest))) console.log(`  ${c}`);
}
