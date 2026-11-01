# Deploy-clean gate

## What it checks

| Code | Blocks when | Why |
|---|---|---|
| `DIRTY_TREE` | `git status` shows any change outside an `--exempt` prefix, including untracked files | Deploy tools bundle the working tree. In a checkout that several sessions share, a dirty tree can hold another session's half-finished edit, which then goes live without review |
| `UNPUSHED_HEAD` | HEAD is on no remote-tracking branch | The deploy record would name a commit nobody else can check out. "Committed" is not "shipped" |

In GitHub Actions the pushed check passes only when HEAD equals `GITHUB_SHA`. The env var alone is not trusted, and
CI never excuses a dirty tree.

## Wiring

```json
{ "scripts": { "predeploy": "node path/to/check-deploy-clean.mjs --exempt state/", "deploy": "wrangler deploy" } }
```

Put it on the production path only. A dev server legitimately runs on a dirty tree.

## The override

`ALLOW_DIRTY_TREE=1` lets the deploy through and prints what it is ignoring. It is an environment variable on
purpose. An approved command string like `deploy --allow-dirty` would be remembered as a permission rule and reused
silently.

## Fail-closed

If git itself errors, the script exits 1. It never reports clean when it could not look.
