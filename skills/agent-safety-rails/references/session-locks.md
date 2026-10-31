# Session locks and messages

## Exclusive resources

Lock before you touch anything where two sessions acting at once would hurt:

- the production deploy target (deploys, canaries, secret changes);
- production database writes and migrations;
- the default branch (merges and pushes);
- a checkout that several sessions share;
- scheduled jobs (cron) configuration.

## Message vocabulary

When sessions can message each other, start every message with one word, so it can be read at a glance:

| Word | Meaning |
|---|---|
| `LOCK` | I hold this resource now. Don't touch it until UNLOCK |
| `UNLOCK` | Released |
| `WAIT` | Please hold off; I am about to need this |
| `CLAIM` / `RELEASE` | I am working on this task / no longer |
| `HANDOFF` | This task moves to you; here is its state |
| `ASK` | I need a decision from you (or from the user, via you) |
| `FYI` | No action needed |
| `MAIN-MOVED` | The default branch moved; rebase before you push |

## Rules, and the failure behind each one

1. **A lock is a present fact.** "…then I'll LOCK main" was read by a peer as a plan, and it pushed. Write
   "LOCK main (held now)".
2. **Broadcast to every live session, every time.** A session that restarted has an empty inbox, even under the
   same name.
3. **"Not reachable" is not "ended".** A session dropped out of the list, a peer took over its release, and the
   first session came back minutes later. Two sessions briefly claimed one canary. Check its claim file and ask
   again a few minutes later before you take over.
4. **A peer's ACCEPT is not the user's GO.** Only the user's explicit approval, given in the chat of the session
   that will act, authorizes a deploy, merge or secret change.
5. **One owner for cross-session work.** A request sent to every session ("reconcile the shared state") ran six
   times in parallel. Name one session to do the roll-up; the others report to it.
6. **The real guard is the gate, not the lock.** Before a push, check that the remote branch is an ancestor of
   yours. The lock only saves wasted runs.

## Claim files

Besides locks, keep one short markdown file per session (for example `~/.claude/coordination/claims/<session>.md`)
saying what it is working on and which files it is editing. Read the others before you edit a shared file. A claim
lapses after a few hours unless it says `awaiting GO`.
