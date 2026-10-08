import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

const routines = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/hermit-routines/SKILL.md'), 'utf8');
const responder = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/channel-responder/SKILL.md'), 'utf8');

test('routine formatting Read bounds cover exactly the canonical section', () => {
  const section = routines.slice(routines.indexOf('**Formatting-only read.**'), routines.indexOf('**Model-override substitution.**'));
  const json = section.match(/```json\n([^\n]+)\n```/)?.[1];
  expect(json).toBeDefined();
  const args = JSON.parse(json!);
  expect(args.file_path).toBe('${CLAUDE_PLUGIN_ROOT}/skills/channel-responder/SKILL.md');
  expect(args.offset).toBeGreaterThan(0);
  expect(args.limit).toBeGreaterThan(0);
  const start = responder.indexOf('### Message formatting\n');
  const end = responder.indexOf('\n## ', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  // Keep the shipped Read arguments aligned when surrounding prose moves.
  const excerpt = responder.split('\n').slice(args.offset - 1, args.offset - 1 + args.limit).join('\n') + '\n';
  expect(excerpt).toBe(responder.slice(start, end + 1));
});

test('inline and delegated routine templates use the bounded Read', () => {
  const dispatch = routines.slice(routines.indexOf('**Model-override substitution.**'), routines.indexOf('Base execution,'));
  const inline = routines.slice(routines.indexOf('Base execution,'), routines.indexOf('**Optional `precheck`'));
  expect(dispatch).toContain('use <formatting-read>');
  expect(inline).toContain('use <formatting-read>');
});
