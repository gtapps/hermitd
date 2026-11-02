// Pins the shared test fixtures against the production readers they feed.
// When cc-compat's field names move, this file fails instead of the seven
// cost/context suites silently reading zeros one by one. It does NOT detect an
// upstream Claude Code schema change — nothing here reads a real transcript.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { triggerPrompt, assistantEntry, assistantEntryFor } from './helpers/transcript';
import { setupWorkdir, writeConfig, freshDirFactory } from './helpers/workdir';
import { extractUsage, turnPromptText } from '../scripts/lib/cc-compat';

describe('transcript fixtures round-trip through cc-compat', () => {
  test('assistantEntry usage survives extractUsage', () => {
    const entry = JSON.parse(assistantEntry({
      model: 'claude-opus-4-8',
      inputTokens: 111,
      cacheRead: 222,
      cacheWrite: 333,
      outputTokens: 444,
    }));
    expect(extractUsage(entry)).toEqual({
      inputTokens: 111,
      cacheWriteTokens: 333,
      cacheReadTokens: 222,
      outputTokens: 444,
      model: 'claude-opus-4-8',
      cacheWrite1hTokens: 0,
      requestId: '',
      fast: false,
    });
  });

  test('defaults are the shape the cost suites rely on', () => {
    expect(extractUsage(JSON.parse(assistantEntry()))).toEqual({
      inputTokens: 2,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 50,
      model: 'claude-sonnet-4-6',
      cacheWrite1hTokens: 0,
      requestId: '',
      fast: false,
    });
  });

  test('assistantEntryFor maps its positional args to model/input/output', () => {
    expect(extractUsage(JSON.parse(assistantEntryFor('claude-opus-4-8', 100, 50)))).toEqual({
      inputTokens: 100,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 50,
      model: 'claude-opus-4-8',
      cacheWrite1hTokens: 0,
      requestId: '',
      fast: false,
    });
  });

  test('timestamp is top-level and only present when passed', () => {
    expect(JSON.parse(assistantEntry({ timestamp: '2026-08-11T10:00:00Z' })).timestamp)
      .toBe('2026-08-11T10:00:00Z');
    expect('timestamp' in JSON.parse(assistantEntry())).toBe(false);
  });

  test('triggerPrompt is what turnPromptText recovers as the turn opener', () => {
    const lines = [triggerPrompt('do the thing'), assistantEntry()];
    expect(turnPromptText(lines, 1)).toEqual({
      text: 'do the thing',
      boundaryFound: true,
      index: 0,
      typed: false,
      joined: false,
    });
  });
});

describe('writeConfig', () => {
  test('writes config.json under the workdir state dir', () => {
    const wd = setupWorkdir();
    try {
      writeConfig(wd.dir, { agent_name: 'test', timezone: 'UTC' });
      const written = JSON.parse(
        fs.readFileSync(path.join(wd.dir, '.hermit', 'config.json'), 'utf8'),
      );
      expect(written).toEqual({ agent_name: 'test', timezone: 'UTC' });
    } finally {
      wd.cleanup();
    }
  });

  test('creates the state dir when it does not exist yet', () => {
    const { freshDir, cleanup } = freshDirFactory('hermit-writeconfig-');
    try {
      const dir = freshDir();
      writeConfig(dir, { agent_name: 'bare' });
      expect(fs.existsSync(path.join(dir, '.hermit', 'config.json'))).toBe(true);
    } finally {
      cleanup();
    }
  });
});
