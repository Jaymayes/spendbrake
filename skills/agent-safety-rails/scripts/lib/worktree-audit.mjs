// worktree-audit.mjs — pure logic for scripts/worktree-audit.mjs. No I/O here, so every rule is unit-testable.
//
// WHY. Agent sessions create a git worktree per task and rarely remove it. After a few weeks there are dozens, some
// merged, some holding the only copy of unpushed work, some referenced by a hook. Deleting the wrong one loses work
// or breaks a hook. The audit NEVER deletes: it classifies and suggests. Every doubt resolves to KEEP.

export const STATES = ['KEEP', 'DIRTY', 'ACTIVE', 'ORPHANED', 'MERGED_CLEAN', 'UPSTREAM_GONE_CLEAN'];
export const REMOVABLE = new Set(['ORPHANED', 'MERGED_CLEAN', 'UPSTREAM_GONE_CLEAN']);

// C:\wt, C:/wt/ and c:\WT all compare equal.
export const normPath = (p) => String(p).trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// `git worktree list --porcelain` → one record per worktree. The first record is the main worktree.
export function parseWorktreeList(porcelain) {
  const out = [];
  for (const block of String(porcelain).split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    if (!lines.length || !lines[0].startsWith('worktree ')) continue;
    const wt = { path: lines[0].slice(9), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
    for (const l of lines.slice(1)) {
      if (l.startsWith('HEAD ')) wt.head = l.slice(5);
      else if (l.startsWith('branch ')) wt.branch = l.slice(7).replace(/^refs\/heads\//, '');
      else if (l === 'detached') wt.detached = true;
      else if (l === 'bare') wt.bare = true;
      else if (l === 'locked' || l.startsWith('locked ')) wt.locked = true;
      else if (l === 'prunable' || l.startsWith('prunable ')) wt.prunable = true;
    }
    out.push({ ...wt, main: out.length === 0 });
  }
  return out;
}

// A `.worktree-keep` file: one path per line, optional "  # reason". Blank lines and full-line comments ignored.
export function parseKeepFile(text) {
  const keep = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^(.*?)\s+#\s*(.*)$/.exec(t);
    keep.set(normPath(m ? m[1] : t), m ? `.worktree-keep: ${m[2]}` : '.worktree-keep');
  }
  return keep;
}

// A worktree whose path appears in a settings file (a hook script, an allowlisted path) is load-bearing: removing it
// breaks that hook. Adds those paths to `protectedMap` and returns it. Matching is on a path boundary, so C:/wt does
// not protect C:/wtscan.
export function protectReferenced(protectedMap, worktrees, label, text) {
  const hay = String(text).replace(/\\\\/g, '/').replace(/\\/g, '/').toLowerCase();
  for (const wt of worktrees) {
    const p = normPath(wt.path);
    if (protectedMap.has(p)) continue;
    const re = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=[/"\'\\s]|$)');
    if (re.test(hay)) protectedMap.set(p, `referenced by ${label}`);
  }
  return protectedMap;
}

// facts: { exists, dirty (count, or null if git status failed), pushed (HEAD on some remote ref),
//          merged (HEAD is an ancestor of the base branch), upstreamGone (its upstream branch was deleted) }
export function classify(wt, facts, protectedMap) {
  const p = protectedMap.get(normPath(wt.path));
  if (p) return { state: 'KEEP', reason: p };
  if (wt.main) return { state: 'KEEP', reason: 'main worktree (repo root)' };
  if (wt.bare) return { state: 'KEEP', reason: 'bare' };
  if (wt.locked) return { state: 'KEEP', reason: 'locked' };
  if (wt.prunable || !facts.exists) return { state: 'ORPHANED', reason: 'directory is gone; only the registration remains' };
  if (facts.dirty === null || facts.dirty === undefined) return { state: 'KEEP', reason: 'git status failed; not judged' };
  if (facts.dirty > 0) return { state: 'DIRTY', reason: `${facts.dirty} uncommitted path(s); never removed automatically` };
  if (!facts.pushed) return { state: 'KEEP', reason: wt.detached ? 'detached at an unpushed commit' : 'branch has unpushed commits' };
  if (facts.merged) return { state: 'MERGED_CLEAN', reason: 'clean, HEAD is in the base branch' };
  if (facts.upstreamGone) return { state: 'UPSTREAM_GONE_CLEAN', reason: 'clean, upstream branch deleted (likely squash-merged)' };
  return { state: 'ACTIVE', reason: 'clean, pushed, not yet merged' };
}

const q = (s) => `"${s}"`;
// Suggestions only — the script prints these and runs none of them.
export function suggest(wt, state) {
  if (state === 'ORPHANED') return ['git worktree prune'];
  if (state === 'MERGED_CLEAN' || state === 'UPSTREAM_GONE_CLEAN') {
    const cmds = [`git worktree remove ${q(wt.path)}`];
    if (wt.branch) cmds.push(state === 'MERGED_CLEAN' ? `git branch -d ${wt.branch}` : `git branch -D ${wt.branch}  # upstream gone: confirm the PR merged first`);
    return cmds;
  }
  return [];
}
