// Contract test: every hooks.json entry fleet-wide uses exec form or the bash -c escape hatch.
// (bun test port of test-hook-registration-form.sh — python3 JSON walk ported to JS)
//
// Guards against regressions to naked shell-form ${CLAUDE_PLUGIN_ROOT} interpolation.
//
// Usage: bun test tests/hook-registration-form.test.ts   (from the plugin root)

import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { MONOREPO_ROOT } from './helpers/run';

test('form contract: all hook entries are exec-form or bash -c', () => {
  const pluginsDir = path.join(MONOREPO_ROOT, 'plugins');
  const hookFiles = fs
    .readdirSync(pluginsDir)
    .map((slug) => path.join(pluginsDir, slug, 'hooks', 'hooks.json'))
    .filter((p) => fs.existsSync(p))
    .sort();

  const problems: string[] = [];
  let count = 0;

  for (const file of hookFiles) {
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
    for (const [event, entries] of Object.entries(doc.hooks ?? {})) {
      for (const entry of entries as Array<{ hooks?: Array<Record<string, unknown>> }>) {
        for (const h of entry.hooks ?? []) {
          count++;
          const cmd = String(h.command ?? '');
          if ('args' in h) {
            if (cmd.includes(' ') || cmd.includes('$')) {
              problems.push(`${file} ${event}: exec-form command has shell chars: ${JSON.stringify(cmd)}`);
            }
            // Bun auto-installs missing imports unless told not to; the plugin directory
            // accepts only this exact form and refuses a script that carries a bun shebang.
            const args = h.args as string[];
            const prefix = '${CLAUDE_PLUGIN_ROOT}/';
            if (cmd === 'bun') {
              if (args.length !== 2 || args[0] !== '--no-install' || !args[1].startsWith(prefix)) {
                problems.push(`${file} ${event}: bun hook args must be ["--no-install", "\${CLAUDE_PLUGIN_ROOT}/<file>"]: ${JSON.stringify(args)}`);
              } else {
                const script = path.join(path.dirname(path.dirname(file)), args[1].slice(prefix.length));
                if (fs.existsSync(script) && fs.readFileSync(script, 'utf-8').startsWith('#!')) {
                  problems.push(`${file} ${event}: hook script has a shebang: ${script}`);
                }
              }
            }
          } else if (cmd.startsWith('bash -c ')) {
            // documented escape hatch for stdin/jq/pipes work
          } else {
            problems.push(`${file} ${event}: naked shell form: ${JSON.stringify(cmd)}`);
          }
        }
      }
    }
  }

  expect(problems).toEqual([]);
  // Path-resolution guard: zero entries means the glob is broken, not that all is well.
  expect(count).toBeGreaterThan(0);
});
