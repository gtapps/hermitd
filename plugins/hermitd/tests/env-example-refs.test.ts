// No plugin in this monorepo ships a `.env.example` file. Operator-facing
// prose that tells the operator to `cp .env.example .env` or "see
// .env.example" points at a file that doesn't exist — a regression class
// that has already shipped and been fixed once (see
// hermitd-homeassistant/CHANGELOG.md:484). This guard scans every
// plugin's shipped prose so the class can't creep back in a second time,
// on any plugin.
//
// CHANGELOG.md is excluded by rule, not allow-list: changelogs are
// historical records, not operator instructions, and legitimately document
// this very fix.
//
// Usage: bun test tests/env-example-refs.test.ts   (from the plugin root)

import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { MONOREPO_ROOT, walkFiles } from './helpers/run';

const SKIP_DIRS = new Set(['node_modules', 'vendor']);

function hitLines(text: string): number[] {
  const out: number[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.includes('.env.example')) out.push(i + 1);
  });
  return out;
}

// Walk plugins/*, collecting skills/**/*.md, agents/**/*.md, docs/**/*.md,
// state-templates/** (*.md, *.template), and plugin-root *.md (excluding
// CHANGELOG.md). Skips node_modules/vendor segments (hermitd-laravel-forge's
// vendored PHP deps carry unrelated matches). Only real plugins are scanned —
// a directory is a plugin iff it has .claude-plugin/plugin.json, which keeps
// gitignored scratch dirs under plugins/ (e.g. graphify-out/) out of the scan.
const PLUGINS_DIR = path.join(MONOREPO_ROOT, 'plugins');

function surfaces(): string[] {
  const out: string[] = [];
  for (const plugin of fs.readdirSync(PLUGINS_DIR)) {
    const pluginRoot = path.join(PLUGINS_DIR, plugin);
    if (!fs.existsSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'))) continue;

    for (const entry of fs.readdirSync(pluginRoot, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'CHANGELOG.md') {
        out.push(path.join(pluginRoot, entry.name));
      }
    }

    for (const sub of ['skills', 'agents', 'docs', 'state-templates']) {
      out.push(...walkFiles(
        path.join(pluginRoot, sub),
        name => name.endsWith('.md') || name.endsWith('.template'),
        SKIP_DIRS,
      ));
    }
  }
  return out;
}

test('no plugin prose references a .env.example', () => {
  // Each offender is reported as `<path>:<line>`.
  const offenders = surfaces().flatMap(file =>
    hitLines(fs.readFileSync(file, 'utf8')).map(line => `${path.relative(MONOREPO_ROOT, file)}:${line}`));
  expect(offenders).toEqual([]);
});
