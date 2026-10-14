// Renders every help surface the CLI can print, in a stable order. Shared by
// tests/cli-help-parity.test.ts and the fixture regeneration one-liner in its
// header comment, so the fixture and the assertion can never drift apart.

import { HA_COMMANDS, main } from '../src/cli';
import { AppConfig } from '../src/config';
import { captureOutput } from './helpers';

/** `-h` exits inside parseArgs, before any config or client is touched. */
const HELP_CONFIG = new AppConfig('/nonexistent', 'http://ha.local:8123', null, null, 'tok', 5, 0);

export function helpInvocations(): string[][] {
  return [
    ['-h'],
    ['boot', '-h'],
    ['boot', 'status', '-h'],
    ['boot', 'store', '-h'],
    ['boot', 'mcp-config', '-h'],
    ['ha', '-h'],
    ...HA_COMMANDS.map((command) => ['ha', command, '-h']),
  ];
}

export async function renderHelp(argv: string[]): Promise<{ code: number; text: string }> {
  const run = await captureOutput(() => main(argv, { loadConfig: () => HELP_CONFIG }));
  return { code: run.code, text: run.out };
}

/** One document: a `$ ha_agent_lab <argv>` header per surface, then its output. */
export async function renderAllHelp(): Promise<string> {
  const chunks: string[] = [];
  for (const argv of helpInvocations()) {
    const { text } = await renderHelp(argv);
    chunks.push(`$ ha_agent_lab ${argv.join(' ')}\n${text}`);
  }
  return chunks.join('\n');
}
