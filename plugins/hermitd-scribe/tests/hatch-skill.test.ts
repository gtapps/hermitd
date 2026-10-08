#!/usr/bin/env bun

// Structural lint for skills/hatch/SKILL.md — grep-level checks, no runtime
// skill execution. Pins the _hermit_versions stamp key, the version-gated
// block refresh (scribe is exempt from the cross-plugin hatch contract, so
// this file is its only guard against skipping on marker-presence alone), the
// block's closing marker, the native-rules install order and the skill route
// named in the injected block.

import { readFileSync } from "node:fs";
import path from "node:path";

const HATCH_SKILL = path.join(import.meta.dir, "..", "skills", "hatch", "SKILL.md");

let pass = 0;
let fail = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  ok    ${name}`);
  } catch (err: any) {
    fail++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

function assertTrue(actual: boolean, label: string) {
  if (!actual) throw new Error(`${label}: expected true`);
}

const text = readFileSync(HATCH_SKILL, "utf8");

test("stamps _hermit_versions[\"hermitd-scribe\"] into config.json", () => {
  assertTrue(text.includes('_hermit_versions["hermitd-scribe"]'), 'contains the stamp key');
});

test("version-gates the block refresh instead of skipping on marker-presence alone", () => {
  assertTrue(
    /stamped version equals plugin version/.test(text),
    'gate compares plugin.json version against the config stamp',
  );
});

test("re-renders on marker absent, stamp null, or stamp stale (not marker-presence-only)", () => {
  assertTrue(
    /marker absent, stamped version null, OR stamped version stale/.test(text),
    'all three refresh conditions are documented',
  );
});

test("replace case bounds the block through the closing marker", () => {
  assertTrue(
    text.includes('<!-- /hermitd-scribe: Issue Filing -->'),
    'closing marker is referenced for the replace-branch bound',
  );
});

test("installs native rules before updating the instruction block, including current versions", () => {
  const install = text.indexOf('scripts/native-permissions.ts');
  const update = text.indexOf('### 2. Update CLAUDE.md / CLAUDE.local.md');
  assertTrue(install > 0 && install < update, 'approval installation precedes block refresh');
  assertTrue(text.includes('including when the version is current'), 'version skips cannot skip approval installation');
  assertTrue(text.includes('If it fails, stop before updating'), 'installation failure stops the hatch');
  assertTrue(text.includes('domain-hatch preflight hermitd-scribe'), 'uses core target resolution');
  assertTrue(text.includes('`.claude/settings.local.json`') && text.includes('`.claude/settings.json`'), 'both project settings scopes are supported');
});

// ── CLAUDE-APPEND block ─────────────────────────────────────────────────────
// The block the hatch injects is the fleet's smallest and is the shape the rest
// should converge to. This pins its skill-only filing route.

const APPEND = readFileSync(
  path.join(import.meta.dir, "..", "state-templates", "CLAUDE-APPEND.md"),
  "utf8",
);

test("APPEND routes all filing through the skill", () => {
  assertTrue(APPEND.includes("/hermitd-scribe:hermit-scribe"), "names the skill as the only path");
});

console.log("");
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
