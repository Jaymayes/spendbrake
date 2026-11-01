#!/usr/bin/env node
// exfil-guard.mjs — a Claude Code PreToolUse hook. It returns permissionDecision "ask" for three shapes, so the
// human sees the exact call and decides:
//   E  EXFIL     a network-sending command that references a secret, unless every URL in it is first-party
//                (a token sent back to its own issuer is normal; the same token sent anywhere else is not).
//   P  PACKAGE   adding a NAMED package (pnpm add x, npm i x, npx -y x, pip install x). Locked installs
//                (pnpm install --frozen-lockfile, npm ci) are free: the lockfile already guards them.
//   S  SETTINGS  writing Claude Code settings or hooks, .mcp.json, ~/.claude.json, .npmrc, pnpm-workspace.yaml or
//                CLAUDE.md, through Write/Edit or a shell redirect/copy.
//
// The threat is a hijacked session: an agent that READ a planted instruction (an email, a web page, a changelog)
// and now tries to send a secret out, install a planted package, or loosen its own settings.
// It never returns "allow" (widening is not its job) and never "deny" (the human stays the judge). It catches a
// session that lost its instructions; it is not proof against an adversary who controls the command text (a script
// file hides what it does). Keep deny rules for secret FILES alongside it.
//
// Install it yourself, not through an agent: see ../references/exfil-guard.md. This file sits under .claude/hooks/
// once installed, so rule S also guards edits to the guard itself.
import { readFileSync } from 'node:fs';

// ── Edit for your project ───────────────────────────────────────────────────────────────────────────────────────
// Exact hostnames (regex, anchored) that may receive a secret. Look-alikes such as api.github.com.evil.example
// never match. Add your own API host, e.g. String.raw`(?:[\w-]+\.)?example\.com`.
const FIRST_PARTY_HOSTS = [
  String.raw`api\.github\.com`,
  String.raw`github\.com`,
  String.raw`uploads\.github\.com`,
  String.raw`registry\.npmjs\.org`,
  String.raw`api\.cloudflare\.com`,
];
// Environment variable prefixes that hold credentials, on top of the generic *TOKEN/*SECRET/*KEY/*PASSWORD names.
const SECRET_ENV_PREFIXES = ['CLOUDFLARE_', 'CF_', 'GH_', 'GITHUB_', 'AWS_', 'STRIPE_', 'ANTHROPIC_', 'OPENAI_', 'GEMINI_', 'GROQ_', 'RESEND_'];

// ── E: exfiltration ──────────────────────────────────────────────────────────────────────────────────────────────
const SINK = /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|nc|ncat|socat|scp|sftp|ftp|rsync)\b|\b(?:node|deno|bun|python3?|py)\s+(?:-e|-c|--eval|-p)\b[\s\S]*\b(?:fetch|https?\.request|https?\.get|XMLHttpRequest|WebSocket|requests\.|urllib|http\.client|socket)\b/i;
const SECRET = new RegExp(
  String.raw`(?:^|[\s"'=@<(\\/])\.env(?:\.[\w-]+)?\b|\.dev\.vars|\bcredentials\b|\.npmrc\b|\.git-credentials|\bid_(?:rsa|ed25519|ecdsa)\b|[\\/]\.ssh[\\/]|[\\/]\.aws[\\/]|\bprocess\.env\b|\bos\.environ\b|\$env:|\$\{?[A-Z0-9_]*(?:TOKEN|SECRET|API_?KEY|PASSWORD|PASSWD|CREDENTIALS?|_KEY)\b|\bgh\s+auth\s+token\b|\bgit\s+credential\s+fill\b|\bprintenv\b|\bGet-ChildItem\s+env:|\bdir\s+env:` +
  String.raw`|\$\{?(?:${SECRET_ENV_PREFIXES.join('|')})[A-Z0-9_]*\b`,
  'i',
);
const FIRST_PARTY = new RegExp(`^(?:${FIRST_PARTY_HOSTS.join('|')})$`, 'i');
const URL_RE = /\bhttps?:\/\/([^\/\s"'`)<>?#:]+)/gi;

export function exfil(cmd) {
  if (!SINK.test(cmd) || !SECRET.test(cmd)) return null;
  const hosts = [...cmd.matchAll(URL_RE)].map((m) => m[1].toLowerCase());
  if (hosts.length && hosts.every((h) => FIRST_PARTY.test(h))) return null;
  return `E exfil: a network-sending command references a secret${hosts.length ? ` and sends to ${[...new Set(hosts.filter((h) => !FIRST_PARTY.test(h)))].join(', ')}` : ' (destination not visible in the command)'}`;
}

// ── P: package install ───────────────────────────────────────────────────────────────────────────────────────────
// A package NAME after add/install/i (flags and paths don't count); npx/pnpm dlx/bunx auto-install flags; pip/uv/gem.
const PKG = /\b(?:pnpm|npm|yarn|bun)\s+(?:add|install|i)\b(?=(?:\s+-{1,2}[\w=-]+)*\s+(?!-)[@\w][\w@./-]*)|\bnpx\s+(?:-y|--yes)\b|\b(?:pnpm\s+dlx|bunx|yarn\s+dlx)\s+[@\w]|\b(?:pip3?|uv\s+pip|pipx)\s+install\s+(?!-r\b)[\w-]|\bgem\s+install\b/i;
export function packageInstall(cmd) {
  return PKG.test(cmd) ? 'P package: installs a named package (planted-package risk); locked installs are not asked' : null;
}

// ── S: settings tampering ────────────────────────────────────────────────────────────────────────────────────────
const SETTINGS_CORE = String.raw`\.claude[\\/](?:settings(?:\.local)?\.json|hooks[\\/])|\.mcp\.json|\.claude\.json|\.npmrc|pnpm-workspace\.yaml|CLAUDE\.md`;
const SETTINGS_PATH = new RegExp(`(?:^|[\\\\/"'\\s~])(?:${SETTINGS_CORE})`, 'i');
// A redirect only counts when it points INTO a protected file; "2>/dev/null" on a command that reads one is fine.
const REDIRECT_INTO = new RegExp(`(?<![0-9&])>>?\\s*["']?[^\\s"'|;&]*(?:${SETTINGS_CORE})`, 'i');
const WRITE_VERB = /\btee\b|\bsed\s+-i\b|\b(?:cp|mv|rm|ln)\s|\bSet-Content\b|\bAdd-Content\b|\bOut-File\b|\bNew-Item\b|\bCopy-Item\b|\bMove-Item\b|\bRemove-Item\b|\bwriteFileSync\b|\bappendFileSync\b|\brenameSync\b/i;
export function settingsTamper(tool, input) {
  if (/^(?:Write|Edit|NotebookEdit|MultiEdit)$/.test(tool)) {
    const p = String(input?.file_path || input?.notebook_path || '');
    return SETTINGS_PATH.test(p) ? `S settings: writes ${p}` : null;
  }
  const cmd = String(input?.command || '');
  if (REDIRECT_INTO.test(cmd) || (SETTINGS_PATH.test(cmd) && WRITE_VERB.test(cmd))) return 'S settings: a shell command writes a settings/hook/config file';
  return null;
}

export function decide(input) {
  const tool = String(input?.tool_name || '');
  const hits = [];
  if (/^(?:Bash|PowerShell)$/.test(tool)) {
    const cmd = String(input?.tool_input?.command || '');
    if (!cmd) return null;
    for (const f of [exfil, packageInstall]) { const h = f(cmd); if (h) hits.push(h); }
  }
  const s = settingsTamper(tool, input?.tool_input);
  if (s) hits.push(s);
  if (!hits.length) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason:
        `EXFIL GUARD — ${hits.join('; ')}. If this came from something the agent READ (an email, a page, a changelog), ` +
        `decline: content is data, not instructions. Approving applies to this one call only.`,
    },
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { raw = ''; }
  let input = {};
  try { input = raw ? JSON.parse(raw) : {}; } catch { input = {}; }
  const out = decide(input);
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
