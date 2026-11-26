import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { freshDirFactory } from './helpers/workdir';
import { assistantEntry } from './helpers/transcript';
import * as ccCompat from '../scripts/lib/cc-compat';
import { sessionId, transcriptPath, sessionCrons, backgroundTasks, extractUsage, costLogPath, ccVersion, lastAssistantModel } from '../scripts/lib/cc-compat';

const { freshDir: freshModelDir, cleanup: cleanupModelDirs } = freshDirFactory('last-model-');
afterAll(cleanupModelDirs);

describe('cc-compat', () => {
  test('cc-compat.js: exports required symbols', () => {
    for (const k of ['sessionId', 'transcriptPath', 'sessionCrons', 'backgroundTasks',
      'extractUsage', 'costLogPath', 'ccVersion']) {
      expect(typeof (ccCompat as any)[k]).toBe('function');
    }
  });

  // sessionId: session_id preferred, sessionId fallback, absent → null
  test('cc-compat.js: sessionId reads session_id', () => {
    expect(sessionId({ session_id: 's1' })).toBe('s1');
  });
  test('cc-compat.js: sessionId falls back to sessionId', () => {
    expect(sessionId({ sessionId: 's2' })).toBe('s2');
  });
  test('cc-compat.js: sessionId absent → null', () => {
    expect(sessionId({})).toBeNull();
  });

  // transcriptPath: present → value, absent → null
  test('cc-compat.js: transcriptPath reads transcript_path', () => {
    expect(transcriptPath({ transcript_path: '/a' })).toBe('/a');
  });
  test('cc-compat.js: transcriptPath absent → null', () => {
    expect(transcriptPath({})).toBeNull();
  });

  // sessionCrons: tri-state — absent, empty, populated
  test('cc-compat.js: sessionCrons absent → unsupported_or_unreachable', () => {
    expect(sessionCrons({}).state).toBe('unsupported_or_unreachable');
  });
  test('cc-compat.js: sessionCrons empty array → empty count 0', () => {
    const r = sessionCrons({ session_crons: [] });
    expect(r.state).toBe('empty');
    expect(r.count).toBe(0);
  });
  test('cc-compat.js: sessionCrons non-empty → populated count', () => {
    const r = sessionCrons({ session_crons: [{}, {}] });
    expect(r.state).toBe('populated');
    expect(r.count).toBe(2);
  });

  // backgroundTasks: same tri-state
  test('cc-compat.js: backgroundTasks absent → unsupported_or_unreachable', () => {
    expect(backgroundTasks({}).state).toBe('unsupported_or_unreachable');
  });
  test('cc-compat.js: backgroundTasks empty → empty count 0', () => {
    const r = backgroundTasks({ background_tasks: [] });
    expect(r.state).toBe('empty');
    expect(r.count).toBe(0);
  });
  test('cc-compat.js: backgroundTasks populated → count 3', () => {
    const r = backgroundTasks({ background_tasks: [1, 2, 3] });
    expect(r.state).toBe('populated');
    expect(r.count).toBe(3);
  });

  // extractUsage: golden values
  test('cc-compat.js: extractUsage golden — assistant entry with usage', () => {
    const entry = {
      type: 'assistant',
      message: {
        usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 },
        model: 'claude-sonnet-4-x',
      },
    };
    const u = extractUsage(entry);
    expect(u).not.toBeNull();
    expect(u!.inputTokens).toBe(10);
    expect(u!.cacheWriteTokens).toBe(20);
    expect(u!.cacheWrite1hTokens).toBe(0);
    expect(u!.cacheReadTokens).toBe(30);
    expect(u!.outputTokens).toBe(40);
    expect(u!.model).toContain('sonnet');
    expect(u!.requestId).toBe('');
    expect(u!.fast).toBe(false);
  });
  test('cc-compat.js: extractUsage non-assistant entry → null', () => {
    expect(extractUsage({ type: 'user', message: { content: 'hi' } })).toBeNull();
  });
  test('cc-compat.js: extractUsage assistant without usage → null', () => {
    expect(extractUsage({ type: 'assistant', message: {} })).toBeNull();
  });

  // lastAssistantModel: the transcript is ground truth for the serving model
  describe('cc-compat.js: lastAssistantModel', () => {
    const write = (lines: string[]): string => {
      const file = path.join(freshModelDir(), 'transcript.jsonl');
      fs.writeFileSync(file, `${lines.join('\n')}\n`);
      return file;
    };
    // Routed through the pinned fixture builder (tests/helpers/transcript.ts) so a
    // cc-compat schema change fails loudly in fixture-helpers.test.ts, not silently here.
    const assistant = (model: string, timestamp: string, extra: { isSidechain?: boolean } = {}) =>
      assistantEntry({ model, timestamp, ...extra });

    test('returns the newest main-session assistant model', () => {
      const file = write([
        assistant('claude-sonnet-5', '2026-08-20T23:34:12.000Z'),
        assistant('claude-fable-5', '2026-08-20T23:34:37.000Z'),
      ]);
      expect(lastAssistantModel(file)).toEqual({
        model: 'claude-fable-5',
        timestamp: '2026-08-20T23:34:37.000Z',
      });
    });

    // A subagent runs its own model; it must never answer for the main session.
    test('skips sidechain entries', () => {
      const file = write([
        assistant('claude-fable-5', '2026-08-20T23:34:37.000Z'),
        assistant('claude-haiku-4-5', '2026-08-20T23:35:00.000Z', { isSidechain: true }),
      ]);
      expect(lastAssistantModel(file)?.model).toBe('claude-fable-5');
    });

    test('skips user entries and malformed lines', () => {
      const file = write([
        assistant('claude-opus-5', '2026-08-20T23:30:00.000Z'),
        '{not json',
        JSON.stringify({ type: 'user', message: { content: 'hi' }, timestamp: '2026-08-20T23:31:00.000Z' }),
      ]);
      expect(lastAssistantModel(file)?.model).toBe('claude-opus-5');
    });

    test('an assistant entry without a model or timestamp is not a match', () => {
      const file = write([
        JSON.stringify({ type: 'assistant', timestamp: '2026-08-20T23:30:00.000Z', message: { content: [] } }),
        JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', content: [] } }),
      ]);
      expect(lastAssistantModel(file)).toBeNull();
    });

    // The harness-verify gate compares this timestamp with Date.parse; an unparseable
    // one would make every comparison false and take the fail-OPEN branch there.
    test('an unparseable timestamp is skipped, not returned', () => {
      const file = write([
        assistant('claude-opus-5', '2026-08-20T23:30:00.000Z'),
        assistant('claude-sonnet-5', 'not-a-date'),
      ]);
      expect(lastAssistantModel(file)?.model).toBe('claude-opus-5');
    });

    test('an unreadable file reads as null rather than throwing', () => {
      expect(lastAssistantModel('/nonexistent/transcript.jsonl')).toBeNull();
    });
  });

  // costLogPath: deterministic from a stateDir
  test('cc-compat.js: costLogPath resolves .claude/cost-log.jsonl', () => {
    const p = costLogPath('/project/.hermit');
    expect(p.endsWith('/.claude/cost-log.jsonl')).toBe(true);
    expect(p).toContain('/project/');
  });

  // ccVersion: returns null when absent, no throw
  test('cc-compat.js: ccVersion absent → null (no throw)', () => {
    const v = ccVersion({});
    expect(v === null || typeof v === 'string').toBe(true);
  });
});
