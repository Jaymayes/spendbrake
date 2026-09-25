// disclosure.ts — deterministic pre-publication checks.
//
// These run as INVERSE GUARDS: content does not publish unless the required markers are
// present. No model call is involved, which is the whole point — asking a model to include a
// disclosure is a request, checking for it is a control.

export interface DisclosureRules {
  /** Require an advertising/affiliate marker (FTC-style). */
  requireAd?: boolean;
  /** Require an AI-generation marker. */
  requireAiGenerated?: boolean;
  /** Additional required literals, matched case-insensitively. */
  requireLiterals?: string[];
}

export type DisclosureKind = "ad" | "ai_generated" | string;

export interface DisclosureDecision {
  allowed: boolean;
  reason: "ok" | "missing_disclosure" | "empty_content";
  missing: DisclosureKind[];
}

/**
 * Default marker patterns. Deliberately permissive about surrounding punctuation and case,
 * deliberately strict about the marker itself — a check that accepts a paraphrase is not a
 * check. Override per-call if your jurisdiction or platform requires different wording.
 */
const AD_PATTERNS: RegExp[] = [
  /(^|[\s(>#])#ad\b/i,
  /\bpaid\s+partnership\b/i,
  /\baffiliate\s+link/i,
  /\bsponsored\b/i,
];

const AI_PATTERNS: RegExp[] = [
  /(^|[\s(>#])#aigenerated\b/i,
  /(^|[\s(>#])#ai\b/i,
  /\bAI[- ]generated\b/i,
  /\bgenerated\s+(?:with|by)\s+AI\b/i,
];

/**
 * Words that turn a marker into its opposite. Without this, "This post is not sponsored" and
 * "contains no affiliate links" satisfied the ad requirement — the guard accepted the literal
 * opposite of a disclosure and failed open.
 */
const NEGATIONS = new Set(["not", "no", "non", "never", "without", "neither", "nor", "zero"]);

/**
 * How far back a negation reaches, in words. Three covers "not sponsored", "not a paid
 * partnership" and "in no way sponsored", while "There is no doubt this is sponsored" still counts
 * as a disclosure because "no" is four words back.
 */
const NEGATION_REACH_WORDS = 3;

/**
 * Is the marker starting at `markerStart` negated? Only the marker's own clause is examined, so a
 * negation in an earlier sentence or clause ("No purchase necessary, sponsored content") cannot
 * cancel a real disclosure. Handles "n't" with a straight or curly apostrophe, and a "non-" prefix.
 */
function isNegated(text: string, markerStart: number): boolean {
  const clause = text.slice(0, markerStart).split(/[.!?;:,()\n]/).pop() ?? "";
  const words = clause
    .toLowerCase()
    .split(/[^a-z'’-]+/)
    .map((w) => w.replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .slice(-NEGATION_REACH_WORDS);
  return words.some((w) => NEGATIONS.has(w) || /n['’]t$/.test(w));
}

/**
 * True when at least one match of any pattern is NOT negated. Every match is examined, so
 * "Not a paid partnership, but it does contain affiliate links" still passes on the second marker.
 */
function hasUnnegatedMarker(text: string, patterns: RegExp[]): boolean {
  for (const re of patterns) {
    // A fresh global copy per call, so no lastIndex state carries between calls.
    const all = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(all)) {
      // Patterns with a leading (^|[\s(>#]) group match one character early; skip past it.
      const markerStart = (m.index ?? 0) + (m[1]?.length ?? 0);
      if (!isNegated(text, markerStart)) return true;
    }
  }
  return false;
}

/**
 * Check content against disclosure rules. Returns every missing marker rather than the first,
 * so an operator fixing a draft sees the whole list in one pass.
 */
export function checkDisclosures(
  content: string,
  rules: DisclosureRules = {},
): DisclosureDecision {
  const text = String(content ?? "");
  if (!text.trim()) {
    return { allowed: false, reason: "empty_content", missing: [] };
  }

  const missing: DisclosureKind[] = [];

  if (rules.requireAd && !hasUnnegatedMarker(text, AD_PATTERNS)) missing.push("ad");
  if (rules.requireAiGenerated && !hasUnnegatedMarker(text, AI_PATTERNS)) missing.push("ai_generated");

  for (const literal of rules.requireLiterals ?? []) {
    const needle = String(literal ?? "").trim();
    if (!needle) continue;
    if (!text.toLowerCase().includes(needle.toLowerCase())) missing.push(needle);
  }

  return missing.length > 0
    ? { allowed: false, reason: "missing_disclosure", missing }
    : { allowed: true, reason: "ok", missing: [] };
}
