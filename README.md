# spendbrake

Gates for running LLM agents in production without hoping they behave.

> Formerly `agent-control-plane`. Old links redirect here.

The first four gates were extracted from a governed autonomous content system that has been
running on Cloudflare Workers since 2025; the reservation and loop gates are newer (see
[Status](#status)). Every gate here is enforcement, not telemetry — each one has an
`allowed: false` path that stops the thing from happening.

MIT licensed. No dependencies. Works on Workers, Node, Deno, or Bun.

## Try it

Not on npm yet. Install straight from GitHub — npm builds it on install:

```sh
npm install github:Jaymayes/spendbrake
```

npm 11 may warn that `spendbrake (prepare: npm run build)` is "not yet covered by allowScripts".
That script is the build, and the install still builds with default settings. If your setup blocks
unapproved scripts, approve it with the command npm suggests: `npm install-scripts approve spendbrake`.

Or work from a clone:

```sh
git clone https://github.com/Jaymayes/spendbrake && cd spendbrake
npm test        # runs the TypeScript tests directly; needs Node 22.18+ — no install step
npm i           # installs TypeScript and builds dist/ via the prepare script
```

The storage tests run the reference SQL against real SQLite (`node:sqlite`), so no database or
account is needed. `npm run test:mutation` injects deliberate bugs into the guards, one at a time
in a scratch copy, and reports any the suite fails to catch.

---

## Why this exists

Most "AI governance" is a dashboard. Something logs a number, a chart goes up, and nothing
in the system is actually prevented from doing anything.

I know this because I shipped exactly that and did not notice for months. The commit message
in my own repo reads:

> the "$5/day kill-switch" was telemetry only — `callAI()` fired inference unconditionally and
> nothing wrote cost, so the cap could neither accrue nor trip.

A cap that cannot accrue and cannot trip is a decorative number. The gates in this package
are the corrected versions: pure decision functions with an explicit blocked state, plus the
storage contract needed to make them binding.

## The gates

| Gate | Prevents | Failure posture |
|---|---|---|
| `budget` | A paid inference from being made once a spend ceiling is reached | Configurable — see below |
| `approval` | Machine-generated content from reaching the public without a human release | Fails closed |
| `disclosure` | Content publishing without required disclosures | Fails closed |
| `retraction` | A published item from staying live once flagged | N/A — always permits removal |
| `reservation` | Concurrent calls from collectively overshooting the cap before any of them is recorded | Fails closed |
| `loop` | An agent loop from running without end: by step count, by repeating one action, or by two agents handing work back and forth | Fails closed |

### 1. Budget gate

A pre-call ceiling. The decision function is pure, so it is testable without a database:

```ts
import { evaluateBudget, estimateCostUsd } from "spendbrake";

const decision = evaluateBudget({
  spentUsd: 0.30,
  capUsd: 0.32,
  killSwitchHit: false,
});
// → { allowed: true, reason: "ok", spentUsd: 0.3, capUsd: 0.32 }
```

Three things make this binding rather than decorative:

**It runs before the call, not after.** A gate that records spend after inference is an
invoice, not a ceiling.

**The cap is sticky.** Once spend crosses the cap, a `killSwitchHit` flag is set and stays
set for the window. Without this, spend that lands concurrently can straddle the boundary
and each individual call sees itself as under the cap.

**A cap that cannot be enforced falls back to the default, never to unlimited.** This is the
single most important line in the file:

```ts
return Number.isFinite(n) && n > 0 ? n : DEFAULT_HARD_CAP_USD; // effectiveCapUsd()
```

A missing config value must not read as "no limit" — and neither may `Infinity`, which an earlier
version accepted as a real cap, so nothing ever blocked. Zero, negative, `NaN`, missing and
`Infinity` all fall back to the default.

**A spend reading that cannot be read blocks.** `NaN`, `undefined`, `null` or garbage returns
`invalid_spend` instead of reading as $0, which would silently reset the day's spend. A numeric
string such as `"0.10"` still counts, since some stores return REAL columns as text. It is the loop
breaker's rule for a corrupt counter, applied to money.

There is a fourth thing that is a real trap and worth stating plainly: **if you write the cap
into a database column with its own default, the code constant is no longer the source of
truth.** Lowering the constant then changes nothing for new rows. The upsert in
`examples/worker.ts` writes `hard_cap_usd` explicitly for that reason.

Two more, both found by testing rather than by reading:

**"At the cap" needs a tolerance.** Money summed in floating point drifts: ten $0.10 calls add
up to `0.9999999999999999`, which is *under* a $1.00 cap. A bare `spent >= cap` therefore never
fires on spend of exactly the cap, and an eleventh call is admitted. Every cap comparison in the
package, JavaScript and SQL alike, uses a shared tolerance of a billionth of a dollar
(`EPSILON_USD`) — far below any real price, so it absorbs representation error without granting
an allowance.

**A cost that cannot be read is unbounded, not free.** `estimateCostUsd` returns `Infinity` when
the token count is not a finite, non-negative number — a provider response with no usage, say.
The call ran and its cost is unknown, so it must not accrue as $0. Recording `Infinity` trips the
cap; `examples/worker.ts` sets the kill switch directly instead, because D1 bindings travel as
JSON, which cannot carry `Infinity`.

### 2. Approval gate

Machine-generated content stages as `pending` and requires an explicit human release. There
is no autonomous publish path — not a flag, not an env var, not an admin override.

```ts
import { evaluateRelease } from "spendbrake";

evaluateRelease({ status: "pending", releasedBy: null });
// → { allowed: false, reason: "awaiting_human_release" }

evaluateRelease({ status: "pending", releasedBy: "operator@example.com" });
// → { allowed: true, reason: "ok" }
```

**Only a `pending` item can be released.** The status check is an allow-list: anything else —
including an unrecognised or mis-cased status such as `"REJECTED"`, `" rejected"` or a missing
one — is refused with `unknown_status`. An earlier version refused the three statuses it knew and
let everything else through, so a mis-cased `"REJECTED"` published as soon as a releaser was set.
Normalise statuses before calling if your store varies case.

A releaser is a non-blank string or a finite number (an integer user id). A boolean, an object or
`NaN` is not a human identity and returns `awaiting_human_release` — it never throws, so the gate,
not your `catch` block, makes the decision.

The gate is deliberately boring. Its value is that it exists in the write path rather than in
a policy document.

### 3. Disclosure guard

Deterministic checks that run before publication — no model call, so they cannot be talked
out of it by a prompt.

```ts
import { checkDisclosures } from "spendbrake";

checkDisclosures(copy, { requireAd: true, requireAiGenerated: true });
// → { allowed: false, reason: "missing_disclosure", missing: ["ai_generated"] }
```

Run these as inverse guards: the content does not publish unless the required markers are
present. Asking a model to include a disclosure is a request. Checking for it is a control.

**A negated marker does not count.** "This post is not sponsored", "contains no affiliate links"
and "not AI-generated" all contain a marker, and an earlier version accepted them — the guard
passed the literal opposite of a disclosure. A marker now counts only when none of the three words
before it, within its own clause, is a negation (`not`, `no`, `non-`, `never`, `without`, `nor`,
`neither`, `zero`, or an `n't` contraction). The clause limit matters: "No purchase necessary,
sponsored content" is still a disclosure. It is a deterministic heuristic, not language
understanding — a negation four or more words back ("not in any way sponsored") is not caught.

**Two more ways a marker can look present and not be:**

- `#ad-free` and `#ai-free` are claims of *no* ad and *no* AI, so a hashtag followed by a hyphen or
  dash does not count. Ordinary punctuation does: `#ad.`, `#ad,` and `(#ad)` all still pass.
- The guard judges what a reader sees. **HTML comments are stripped first**, so `<!-- #ad -->` is
  not a disclosure, and an unterminated `<!--` hides everything after it. Required literals are
  judged the same way. CSS-hidden text (`display:none`) is **not** detected — that needs rendering,
  which a deterministic text check does not do. Pass rendered text if your copy can hide content.

### 4. Retraction

One status flag takes a published item down everywhere, with no redeploy. This is the gate
people skip, and it is the one that matters when something goes wrong at 2am. If your
rollback path is a deploy, you do not have a rollback path.

### 5. Reservation gate

The budget gate compares spend that has already been recorded against the cap. Calls that are
still in flight have not been recorded yet, so ten concurrent calls can each read "under the
cap" and together overshoot it. The sticky kill switch stops the call *after* the overshoot. A
reservation stops the overshoot: each call holds its worst-case cost against the cap before it
runs, and every outstanding hold counts against the cap for everyone else.

```ts
import { estimateMaxCostUsd, evaluateReservation, settleReservation } from "spendbrake";

const worst = estimateMaxCostUsd("llama-3.3-70b", promptTokens, maxOutputTokens);
const d = evaluateReservation({ spentUsd: 0.1, reservedUsd: 0.2, capUsd: 0.32 }, worst);
// → { allowed: false, reason: "would_exceed_cap", ... }  spend alone was under the cap

// After the call, release the hold and record what it really cost:
const s = settleReservation({ reservedUsd, holdUsd: d.reserveUsd, actualUsd });
// → { reservedUsd, accrueUsd, overrun }  overrun = the call beat its worst case
```

Every way of not knowing the cost fails closed:

- **No output limit, or a model with no price in the table** — there is no worst case, so
  `estimateMaxCostUsd` returns `Infinity` and the gate refuses the call. It does not guess a rate,
  and it does not read "no price" as free. Price the worst case at the rate your provider will
  actually bill for that request, including long-context tiers.
- **An estimate that is `NaN`, negative or missing** — refused, not treated as zero.
- **A spend or outstanding-holds reading that cannot be read** — refused as `invalid_state`. A
  corrupt holds total read as $0 would buy headroom that does not exist.
- **An actual cost that cannot be read** — settlement charges the hold, never zero, and says so
  (`actualUnknown: true`). A zero there would refund the whole hold for a call that ran.
- **A hold that never settles** (crash, timeout) — it expires *as spent*. Ledger escrow refunds an
  expired hold; this does not, because a call that timed out on your side may still have billed
  on the provider's.

The pure functions decide; storage has to enforce. The concurrency guarantee only holds if the
check and the hold are one atomic step, so the package ships the SQL too — see
[Storage contract](#storage-contract).

### 6. Loop breaker

A pipeline with no terminal condition, no step counter and no per-agent cap can loop for days
while every individual step looks fine, so nothing ever errors. This gate is the step counter, a
no-progress detector, and an oscillation detector for the two-agent ping-pong — one agent asks for
more work, the other obliges — where no single action ever repeats back to back.

```ts
import { evaluateLoop } from "spendbrake";

evaluateLoop({ iteration: 25, maxIterations: 25 });
// → { allowed: false, reason: "max_iterations", ... }

evaluateLoop({ iteration: 4, recentActions: ["search:a", "verify:r1", "verify:r1", "verify:r1"] });
// → { allowed: false, reason: "no_progress", repeatCount: 3, ... }

evaluateLoop({ iteration: 6, recentActions: ["analyze:r1", "verify:r1", "analyze:r1", "verify:r1", "analyze:r1", "verify:r1"] });
// → { allowed: false, reason: "oscillation", ... }
```

You choose the action fingerprint, for example `${tool}:${hash(args)}`. A missing or non-positive
limit falls back to 25, never to unlimited. A corrupt counter (`NaN`, missing) blocks rather than
reading as zero, because resetting a runaway loop's counter by accident is the failure this exists
to prevent.

---

## Failure posture: the decision you have to make consciously

When the gate itself cannot reach its store, does it allow or block?

**Fail-open** keeps the system running through a database blip, and treats the ceiling as a
backstop rather than a security boundary.

**Fail-closed** treats the ceiling as binding, and accepts that a store outage stops
inference entirely.

This package defaults to **fail-closed** and makes the alternative explicit:

```ts
evaluateBudgetOnStoreError(capUsd, { onStoreError: "allow" }); // opt in deliberately
```

The system this came from splits it deliberately: **interactive paths fail open, background
workers fail closed.** A user waiting on a response should not get a 500 because the spend
ledger blinked; a cron job at 3am with nobody watching should stop. That split is written down
at the top of the worker, next to the code, which is the only place a policy survives.

I recommend the same split, and this package makes you say which one you are in:

```ts
evaluateBudgetOnStoreError(cap, { onStoreError: "allow" }); // interactive
evaluateBudgetOnStoreError(cap);                            // background — default
```

The failure I would flag instead is subtler and I shipped it: the fail-open branch returned a
**hardcoded** cap figure in its error payload. When the real cap moved, that literal did not,
and the API cheerfully reported a ceiling ~15x higher than the enforced one. Nothing was
mis-enforced — the number was cosmetic — but anyone reading the 429 body was misinformed for
months. This package returns `capUsd: null` on that path, because reporting "unknown" is
honest and reporting a stale number is worse than reporting nothing.

Pick a posture per path. Write down why, next to the code. Then keep numbers out of comments
and error strings, where nothing forces them to stay true.

---

## Storage contract

The gates are pure. You supply the state. `schema.sql` has a reference D1/SQLite schema —
a spend window, its open reservations, and an approval queue.

The spend row must be updated atomically. The reference upsert flips the sticky switch in the
same statement that accrues the cost, so a concurrent write cannot slip past the boundary:

```sql
kill_switch_hit = CASE WHEN total_spend_usd + ?1 >= hard_cap_usd - 1e-9 THEN 1 ELSE kill_switch_hit END
```

If you cache the gate decision (recommended — this runs on every inference), **invalidate the
cache on accrual**, not just on TTL expiry. Otherwise the tripped state is invisible for the
length of your TTL, which is exactly the window in which spend is running hottest.

Reservations need more than one row, and D1 has no interactive `BEGIN`/`COMMIT`, so a JavaScript
read-then-write cannot make them safe. `RESERVATION_SQL` exports the statements as plain strings
(no driver dependency). The admission check is a single guarded `INSERT ... SELECT ... WHERE`:

```sql
WHERE w.kill_switch_hit = 0
  AND w.total_spend_usd < w.hard_cap_usd
  AND w.total_spend_usd + (open holds for the window) + ?3 <= w.hard_cap_usd + 1e-9
```

Zero rows inserted means refused. Settle and expire each run as one D1 batch, and both match only
open reservations, so a retried settle is a no-op. `examples/worker.ts` wires `reserveCall`,
`settleCall` and a cron `expireStaleHolds`. `test/storage-contract.test.ts` runs these exact
strings against SQLite, including a seeded property test that no interleaving of reserves and
settles puts spend plus open holds over the cap.

---

## What this is not

- Not a prompt firewall, jailbreak filter, or content classifier.
- Not an eval harness.
- Not a policy engine with a rules DSL. A handful of gates, plain functions.
- Not a substitute for your provider's own spend limits. Set those too — and make sure the
  cheaper of the two ceilings is the one that binds. Mine did not for a while: a $5/day cap
  permitted roughly $150/month against a $10/month provider limit, which made the local gate
  non-binding in every month it mattered.

## Prior art

None of these ideas are new here, and the reservation and loop gates lean on others' work:

- **Pre-call budget reservation** ships on by default in the
  [LiteLLM proxy](https://docs.litellm.ai/docs/proxy/users), which reserves before the call and
  replaces the hold with the priced cost afterwards. Its open issue
  [#35524](https://github.com/BerriAI/litellm/issues/35524) — reservation skipped when a request
  cannot be priced — is the fail-open case this package refuses by design.
- **Two-phase reserve/commit** is standard ledger practice; see TigerBeetle's
  [two-phase transfers](https://docs.tigerbeetle.com/coding/two-phase-transfers/). spendbrake
  departs from it on one point, deliberately: an expired hold is charged, not refunded.
- **Composable termination conditions** for agent loops are in AutoGen's termination API (AutoGen
  is now in maintenance mode; Microsoft points new work to Microsoft Agent Framework).
- **Budget-overrun incidents** are catalogued in *Token Budgets: An Empirical Catalog of 63
  LLM-Agent Budget-Overrun Incidents* ([arXiv:2606.04056](https://arxiv.org/abs/2606.04056)).
  It did not study this package.

What this package adds is narrow: pure decision functions with no dependencies, a fail-closed
answer to every "cost unknown" case, and SQL that is tested rather than described.

## Status

v0. The budget, approval, disclosure and retraction gates were extracted from a running system,
generalized, and re-tested in isolation. The originals are in production; these versions are not
yet, which is the honest distinction. The reservation and loop gates were written for this package
afterwards, from the failures described above and in the prior art. They have tests, including the
storage SQL, but they have not run in production anywhere.

## Field notes

The system this package was extracted from publishes its failures with the queries included.

- [Failure autopsy 01: for ten days, most of my click data was me](docs/failure-autopsy-01.md)
- [Failure autopsy 02: my kill switch has never once fired](docs/failure-autopsy-02.md) — carries a
  published correction: it claimed a fix that had been committed to a local branch and never shipped.
- [Failure autopsy 03: for 35 days my publish hook did nothing, successfully](docs/failure-autopsy-03.md)

## Author

Built and run by **Jamarr Mayes** — two decades in regulated sales, now building governed AI systems solo.
[LinkedIn](https://www.linkedin.com/in/jamarrmayes) · [referralsvc.com/about](https://referralsvc.com/about)

## License

MIT
