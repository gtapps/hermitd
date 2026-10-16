// Checklist classifiers and alert-key helpers shared by precheck, alert-update,
// and their coherence tests.

import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './hash';

// Does a HEARTBEAT.md checklist item represent the default proposal-scan item?
// Matches the shipped default ("Review `proposals/` for any with `status:
// proposed` …"): it references proposals AND the `proposed` status it scans for.
// A custom item that merely mentions proposals without that status keyword falls
// through to the generic alert-based rule (unchanged, conservative).
//
// Residual (documented, not eliminated): a compound custom item that DOES contain
// both `proposals/` and `proposed` plus an unrelated clause is classified here and
// can reach 'clean' on an empty queue, skipping the unrelated clause's LLM eval.
// The robust fix is a structural marker in the template, but `hermit-evolve` does
// not migrate operator-edited HEARTBEAT.md, so prose-matching is retained to keep
// the optimization working for existing installs. The coherence test in
// heartbeat-default-scan.test.ts pins the shipped template against this predicate
// so a template reword can't silently reintroduce the wasted-dispatch bug.
export function isProposalScanItem(itemText: string): boolean {
  return /proposals?[\/\s]/i.test(itemText) && /\bproposed\b/i.test(itemText);
}

// Does a HEARTBEAT.md checklist item represent the default credential-expiry item?
// Matches the shipped default ("Read `state/doctor-report.json` → the
// `credential-expiry` check …"): it references doctor-report.json AND the
// credential-expiry check it reads. A custom item that merely mentions one
// without the other falls through to the generic alert-based rule (unchanged,
// conservative).
//
// Residual (documented, not eliminated): a compound custom item that DOES contain
// both `doctor-report.json` and `credential-expiry` plus an unrelated clause is
// classified here and can reach 'clean' on a healthy report, skipping the
// unrelated clause's LLM eval. Same residual as isProposalScanItem: prose-matching
// is retained because hermit-evolve does not migrate operator-edited HEARTBEAT.md.
export function isCredentialExpiryItem(itemText: string): boolean {
  return /doctor-report\.json/i.test(itemText) && /credential-expiry/i.test(itemText);
}

function alnumSlug(text: string, maxLen: number): string {
  return text
    .replace(/^[-*+]\s*(\[.\]\s*)?/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, maxLen);
}

// Normalises a HEARTBEAT.md checklist item to its dedup key.
// Key format: 'checklist:<first-32-chars-normalized>-<first-8-hex-of-body-hash>'.
export function normalizeItemKey(itemText: string): string | null {
  const body = itemText.replace(/^[-*+]\s*(\[.\]\s*)?/, '')
    .replace(/\s*\[(ask|act|note)\]\s*$/i, '')
    .trim().toLowerCase().replace(/\s+/g, ' ');
  const slug = alnumSlug(body, 32);
  return slug ? `checklist:${slug}-${sha256(body).slice(0, 8)}` : null;
}

// Fallback key for unresolvable / freeform firing entries.
// Key format: 'custom:<first-100-chars-normalized>'.
export function normalizeCustomKey(text: string): string | null {
  const n = alnumSlug(text, 100);
  return n ? `custom:${n}` : null;
}

export function parseChecklistItems(content: string): string[] {
  return content
    .split('\n')
    .map(l => l.trim())
    .filter(l => /^[-*+]\s/.test(l));
}

/** Derived key set from `<stateDir>/HEARTBEAT.md`. `null` on any read failure. */
export function canonicalChecklistKeys(stateDir: string): Set<string> | null {
  try {
    const content = fs.readFileSync(path.join(stateDir, 'HEARTBEAT.md'), 'utf-8');
    const keys = new Set<string>();
    for (const item of parseChecklistItems(content)) {
      const key = normalizeItemKey(item);
      if (key) keys.add(key);
    }
    return keys;
  } catch {
    return null;
  }
}
