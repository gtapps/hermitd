// Byte-parity net for the argparse-compatible help output. Every usage string,
// per-command description block, and the command list itself are pinned to
// tests/fixtures/cli-help.txt — any drift turns this red.
//
// Regenerate the fixture (only when a help change is intended):
//   bun -e "import {renderAllHelp} from './tests/help-render'; \
//     await Bun.write('tests/fixtures/cli-help.txt', await renderAllHelp())"

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HA_COMMANDS } from '../src/cli';
import { helpInvocations, renderAllHelp, renderHelp } from './help-render';

const FIXTURE = join(import.meta.dir, 'fixtures', 'cli-help.txt');

test('every help surface exits 0 and prints something', async () => {
  for (const argv of helpInvocations()) {
    const { code, text } = await renderHelp(argv);
    expect(code).toBe(0);
    expect(text.length).toBeGreaterThan(0);
  }
});

test('help output is byte-identical to the fixture', async () => {
  expect(await renderAllHelp()).toBe(readFileSync(FIXTURE, 'utf8'));
});

test('the fixture covers every ha command plus every boot command', () => {
  const fixture = readFileSync(FIXTURE, 'utf8');
  for (const command of HA_COMMANDS) {
    expect(fixture).toContain(`$ ha_agent_lab ha ${command} -h\n`);
  }
  expect(fixture).toContain('$ ha_agent_lab boot status -h\n');
  expect(fixture).toContain('$ ha_agent_lab boot store -h\n');
  expect(fixture).toContain('$ ha_agent_lab boot mcp-config -h\n');
});
