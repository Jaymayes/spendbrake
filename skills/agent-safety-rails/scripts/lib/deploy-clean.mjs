// deploy-clean.mjs — the judgement check-deploy-clean.mjs makes, kept pure so it can be tested without a repository.
//
// WHY. Most deploy tools (wrangler, vercel, firebase, plain rsync) bundle the WORKING TREE, not a commit. Two ways
// that ships code no reviewer ever saw:
//   1. uncommitted changes — a local edit goes live without being committed, reviewed or tested in CI. When several
//      agent sessions share one checkout, it can be ANOTHER session's half-finished edit;
//   2. an unpushed HEAD — a commit that exists only on this machine, so the deploy record names a SHA nobody else
//      can check out, and "committed" gets mistaken for "shipped".

/** Paths from `git status --porcelain` output that are not under an exempt prefix. Handles renames and quoted paths. */
export function dirtyPaths(porcelain, exemptPrefixes = []) {
  return String(porcelain || '')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      let p = l.slice(3);
      if (p.includes(' -> ')) p = p.split(' -> ').pop();
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      return p.replace(/\\/g, '/');
    })
    .filter((p) => !exemptPrefixes.some((x) => p.startsWith(x)));
}

/**
 * @param {{ dirty: string[], remoteRefs: string[], head: string, githubActions?: boolean, githubSha?: string }} s
 * @returns {{ ok: boolean, problems: { code: 'DIRTY_TREE'|'UNPUSHED_HEAD', detail: string }[] }}
 */
export function judgeDeployTree({ dirty, remoteRefs, head, githubActions = false, githubSha = '' }) {
  const problems = [];
  if (dirty.length) problems.push({ code: 'DIRTY_TREE', detail: `${dirty.length} uncommitted path(s): ${dirty.slice(0, 8).join(', ')}${dirty.length > 8 ? ', …' : ''}` });
  // GitHub Actions checks out exactly the dispatched commit, which is pushed by construction. The env var alone is
  // not trust: HEAD must equal GITHUB_SHA. Anything else must be reachable from at least one remote-tracking branch.
  const pushedByCi = githubActions && !!head && head === githubSha;
  if (!pushedByCi && !remoteRefs.length) problems.push({ code: 'UNPUSHED_HEAD', detail: `${(head || '?').slice(0, 8)} is on no remote branch` });
  return { ok: problems.length === 0, problems };
}
