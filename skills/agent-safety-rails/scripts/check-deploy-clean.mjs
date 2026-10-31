#!/usr/bin/env node
/**
 * check-deploy-clean — refuse to deploy a tree that matches no pushed commit.
 *
 *   node check-deploy-clean.mjs [--exempt <prefix>]...
 *
 * Exits 1 when the checkout has uncommitted changes (outside any --exempt prefix, e.g. --exempt state/ for a
 * directory of operational records the build never reads) or when HEAD is on no remote branch. Wire it in front of
 * the real deploy (a `predeploy` npm script, or the first line of your release script), NOT in front of a local
 * dev server: a dirty tree is the normal state while developing.
 *
 * Offline by design: it reads local remote-tracking refs and does not fetch.
 *
 * ESCAPE HATCH: ALLOW_DIRTY_TREE=1, an env var rather than a flag so it cannot become part of an approved command
 * string. It overrides both checks, loudly.
 */
import { execFileSync } from 'node:child_process';
import { dirtyPaths, judgeDeployTree } from './lib/deploy-clean.mjs';

const args = process.argv.slice(2);
const exempt = args.flatMap((a, i) => (a === '--exempt' && args[i + 1] ? [args[i + 1]] : a.startsWith('--exempt=') ? [a.slice(9)] : []));

// raw: porcelain lines start with a status column that may be a space, so `git status` output must NOT be trimmed
// (trimming turns ` M src/x.ts` into `rc/x.ts`).
const raw = (a) => execFileSync('git', a, { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
const git = (a) => raw(a).trim();

try {
  git(['rev-parse', '--git-dir']);
} catch {
  console.log('check-deploy-clean: not a git checkout — skipping.');
  process.exit(0);
}

let verdict;
try {
  const head = git(['rev-parse', 'HEAD']);
  const dirty = dirtyPaths(raw(['status', '--porcelain', '--untracked-files=all']), exempt);
  const remoteRefs = git(['branch', '-r', '--contains', 'HEAD']).split('\n').map((s) => s.trim()).filter(Boolean);
  verdict = judgeDeployTree({ dirty, remoteRefs, head, githubActions: process.env.GITHUB_ACTIONS === 'true', githubSha: process.env.GITHUB_SHA || '' });
} catch (err) {
  // "I could not check" is not "it is clean": fail closed.
  console.error(`\n  ✗ check-deploy-clean: COULD NOT VERIFY the tree (${err.message.split('\n')[0]}).\n`);
  process.exit(1);
}

if (verdict.ok) {
  console.log('check-deploy-clean: tree is clean and HEAD is pushed.');
  process.exit(0);
}

const lines = verdict.problems.map((p) => `    - ${p.code}: ${p.detail}`).join('\n');
if (process.env.ALLOW_DIRTY_TREE === '1') {
  console.warn(`\n  ! check-deploy-clean: proceeding anyway because ALLOW_DIRTY_TREE=1:\n${lines}\n`);
  process.exit(0);
}
console.error(
  `\n  ✗ check-deploy-clean: THIS TREE MATCHES NO PUSHED COMMIT.\n${lines}\n\n` +
  `    A deploy bundles the working tree, so this would put unreviewed code live under a SHA that\n` +
  `    does not describe it. Deploy from a clean checkout of a pushed commit, or commit and push first.\n\n` +
  `    Override only if you accept that risk:\n      ALLOW_DIRTY_TREE=1 <your command>\n`
);
process.exit(1);
