// mcp-login skill anchors: the native auth tools, maintainer-tier links, and the relogin hand-off.

import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

test('mcp-login relays the session auth tools and keeps the callback private', () => {
  const skill = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'mcp-login', 'SKILL.md'), 'utf8');
  for (const phrase of ['__authenticate', 'complete_authentication', 'callback_url', '--tier maintainer', 'never repeat it', '/hermitd:relogin']) {
    expect(skill).toContain(phrase);
  }
});
