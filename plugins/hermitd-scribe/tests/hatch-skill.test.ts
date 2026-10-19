#!/usr/bin/env bun

// Structural lint for the version stamp, native approval installation and report.

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

test("installs native rules before stamping, including current versions", () => {
  const install = text.indexOf('scripts/native-permissions.ts');
  const update = text.indexOf('### 2. Stamp version');
  assertTrue(install > 0 && install < update, 'approval installation precedes version stamp');
  assertTrue(text.includes('including when the version is current'), 'version skips cannot skip approval installation');
  assertTrue(text.includes('If it fails, stop.'), 'installation failure stops the hatch');
  assertTrue(text.includes('deny_conflicts') && text.indexOf('deny_conflicts', text.indexOf('### 3. Final report')) > 0, 'final report names deny conflicts');
  assertTrue(text.includes('domain-hatch preflight hermitd-scribe'), 'uses core target resolution');
  assertTrue(text.includes('`.claude/settings.local.json`') && text.includes('`.claude/settings.json`'), 'both project settings scopes are supported');
});

console.log("");
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
