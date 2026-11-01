# Worktree audit

## States

| State | Meaning | Suggested |
|---|---|---|
| `KEEP` | Main worktree, locked, bare, in `.worktree-keep`, referenced by a settings/hook file, unpushed, or git status failed | nothing |
| `DIRTY` | Has uncommitted changes | nothing; ask whoever owns it |
| `ACTIVE` | Clean and pushed, not merged yet | nothing |
| `ORPHANED` | Directory is gone; only git's registration remains | `git worktree prune` |
| `MERGED_CLEAN` | Clean, and HEAD is in the base branch | `git worktree remove` + `git branch -d` |
| `UPSTREAM_GONE_CLEAN` | Clean, and its upstream branch was deleted (often a squash merge) | `git worktree remove` + `git branch -D`, after confirming the PR merged |

Order matters: protection is checked first, and every doubt resolves to KEEP.

## `.worktree-keep`

```text
# long-lived worktrees that must never be suggested for removal
C:/deploy-clean    # clean checkout used only for production deploys
/home/me/hooks-wt  # the exfil guard runs from here
```

## Why hook references matter

If a settings file runs a hook script from a worktree path, removing that worktree silently disables the hook. The
audit reads `~/.claude/settings.json` and `settings.local.json` and protects any worktree whose path appears in them,
matching on a path boundary (`C:/wt` does not protect `C:/wtscan`).

## The audit never acts

It prints commands; a human (or the session that owns the worktree) runs them, after checking no open session is
working inside it.
