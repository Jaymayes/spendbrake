// approval-gate.ts — machine-generated content requires an explicit human release.
//
// There is no autonomous publish path. Not a flag, not an env var, not an admin override.
// The gate is deliberately boring; its value is that it sits in the write path rather than
// in a policy document.

export type ItemStatus = "pending" | "released" | "rejected" | "retracted";

export interface ReleaseState {
  status: ItemStatus;
  /** Identity of the human releasing it: a name/email, or a numeric user id. Null/empty means nobody has. */
  releasedBy?: string | number | null;
}

export type ReleaseReason =
  | "ok"
  | "awaiting_human_release"
  | "already_rejected"
  | "already_retracted"
  | "already_released"
  | "unknown_status";

export interface ReleaseDecision {
  allowed: boolean;
  reason: ReleaseReason;
}

/**
 * Decide whether an item may be published.
 *
 * Fails closed on every path that is not an explicit human release. Note that a rejected or
 * retracted item can never be published by re-releasing it — it must be re-staged as a new
 * item, so that the audit trail records a decision rather than a status flip.
 *
 * The status check is an ALLOW-list: only exactly "pending" can be released. An earlier version
 * refused the three statuses it knew and let everything else through, so "REJECTED", " rejected",
 * "archived" or a missing status published as soon as a releaser was set. Anything unrecognised is
 * now refused as `unknown_status`; normalise statuses before calling if your store varies case.
 */
export function evaluateRelease(s: ReleaseState): ReleaseDecision {
  if (s.status === "rejected") return { allowed: false, reason: "already_rejected" };
  if (s.status === "retracted") return { allowed: false, reason: "already_retracted" };
  if (s.status === "released") return { allowed: false, reason: "already_released" };
  if (s.status !== "pending") return { allowed: false, reason: "unknown_status" };

  // A releaser is a non-blank string, or a finite number (an integer user id). Anything else —
  // a boolean, an object, NaN — is not a human identity and fails closed. An earlier version called
  // .trim() on whatever arrived, so an integer id threw TypeError and the caller's catch decided.
  const raw: unknown = s.releasedBy;
  const by =
    typeof raw === "string" ? raw.trim() : typeof raw === "number" && Number.isFinite(raw) ? String(raw) : "";
  if (!by) return { allowed: false, reason: "awaiting_human_release" };

  return { allowed: true, reason: "ok" };
}

/**
 * Retraction is the inverse gate and is ALWAYS permitted. Taking something down must never
 * be blocked by the thing that let it up. If your rollback path requires a deploy, you do
 * not have a rollback path.
 */
export function evaluateRetraction(s: Pick<ReleaseState, "status">): ReleaseDecision {
  if (s.status === "retracted") return { allowed: false, reason: "already_retracted" };
  return { allowed: true, reason: "ok" };
}
