import { describe, test, expect, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { verbCreate, verbRoutine, grabHeader, parseStringArray, proposalDigest } from '../scripts/proposal';
import { decodeTask, mutateTask } from '../scripts/lib/tasks';
import { withDir } from './helpers/workdir';

function seed(dir: string): string {
  const base = path.join(dir, '.hermit');
  fs.writeFileSync(path.join(base, 'config.json'), '{}');
  return base;
}
const body = '## Context\nEvidence.\n\n## Proposed Solution\nChange it.\n';
const input = (title = 'Ship the thing') => `Title: ${title}\nSource: auto-detected\nCategory: improvement\nTags: ["architecture"]\n---\n${body}`;

describe('task-backed proposal creation', () => {
  test('one receipt, complete metadata, verbatim proposal, and replay-safe created metrics', withDir(async dir => {
    const base = seed(dir);
    const receipt = verbCreate(base, input());
    expect(Object.keys(receipt)).toEqual(['id', 'handle']);
    expect(receipt.id).toMatch(/^T-\d{8}-\d{6}(-[a-z0-9])?$/);
    const record = decodeTask(fs.readFileSync(path.join(base, 'tasks', receipt.id + '.md'), 'utf8'));
    expect(record).toMatchObject({ requester: 'agent', kind: 'proposal', approver: null, source: 'auto-detected', category: 'improvement', tags: '["architecture"]', waiting_on: 'admin', dedupe_key: 'proposal:ship-thing' });
    expect(record.body).toContain('## Proposal\n' + body);
    expect(JSON.parse(record.decision!)).toEqual({ purpose: 'consent', authority: 'admin', generation: 1 });
    expect(verbCreate(base, input())).toEqual(receipt);
    const rows = fs.readFileSync(path.join(base, 'state', 'proposal-metrics.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'created', proposal_id: receipt.id, source: record.source, category: record.category, tags: ['architecture'] });
    expect(fs.existsSync(path.join(base, 'proposals'))).toBe(false);
  }));
  test.each([
    ['Title: x\nbody', 'missing_separator'],
    ['Title: x\n---\n ', 'empty_body'],
    ['Source: manual\n---\nx', 'missing_title'],
    ['Title: x\nCategory: other\n---\nx', 'invalid_category'],
    ['Title: x\nTags: [1]\n---\nx', 'invalid_tags'],
    ['Title: x\nRelated-Sessions: {}\n---\nx', 'invalid_related_sessions'],
  ])('invalid input writes nothing: %s', (stdin, error) => withDir(async dir => {
    const base = seed(dir);
    expect(verbCreate(base, stdin)).toEqual({ error });
    expect(fs.existsSync(path.join(base, 'tasks'))).toBe(false);
    expect(fs.existsSync(path.join(base, 'state', 'proposal-metrics.jsonl'))).toBe(false);
  })());
  test('metrics failure warns without losing or duplicating the task', withDir(async dir => {
    const base = seed(dir);
    fs.mkdirSync(path.join(base, 'state', 'proposal-metrics.jsonl'));
    const receipt = verbCreate(base, input());
    expect(receipt.warnings).toEqual(['metrics_append_failed']);
    expect(decodeTask(fs.readFileSync(path.join(base, 'tasks', receipt.id + '.md'), 'utf8')).kind).toBe('proposal');
    expect(verbCreate(base, input())).toEqual({ id: receipt.id, handle: receipt.handle });
  }));
  test('a failed record write never appends a created event', withDir(async dir => {
    const base = seed(dir);
    fs.writeFileSync(path.join(base, 'tasks'), 'blocked');
    expect(verbCreate(base, input()).error).toBeTruthy();
    expect(fs.existsSync(path.join(base, 'state', 'proposal-metrics.jsonl'))).toBe(false);
  }));
});

describe('proposal inventory digest', () => {
  test('includes open, cancelled and completed records and bounds its output', withDir(async dir => {
    const base = seed(dir);
    const first = verbCreate(base, input('Open'));
    const second = verbCreate(base, input('Dismissed'));
    const third = verbCreate(base, input('Completed'));
    fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({ channels: { discord: { operators: ['admin'] } } }));
    mutateTask(base, 'answer', second.id, { chat: 'discord:home', user: 'admin', reply: 'no' }, '');
    mutateTask(base, 'answer', third.id, { chat: 'discord:home', user: 'admin', reply: 'yes' }, '');
    mutateTask(base, 'close', third.id, { by: 'confirmed', actor: 'admin', chat: 'discord:home', user: 'admin', 'reason-stdin': true }, 'Done');
    const digest = proposalDigest(base);
    expect(digest.proposals.map((record: any) => record.id)).toContain(first.id);
    expect(digest.proposals.find((record: any) => record.id === second.id).closed_by).toBe('cancelled');
    expect(digest.proposals.find((record: any) => record.id === third.id).closed_by).toBe('confirmed');
    expect(digest.total).toBe(3);
  }));
  test('unreadable inventory never becomes an empty digest', withDir(async dir => {
    const base = seed(dir); verbCreate(base, input());
    const read = fs.readdirSync;
    const spy = spyOn(fs, 'readdirSync').mockImplementation(((directory: any, options: any) => {
      if (String(directory) === path.join(base, 'tasks')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return read(directory, options);
    }) as typeof fs.readdirSync);
    try { expect(proposalDigest(base)).toEqual({ error: 'inventory_read_failed' }); }
    finally { spy.mockRestore(); }
  }));
});

describe('the remaining write verbs', () => {
  test('routine upserts by id', withDir(async (dir) => {
    const base = seed(dir);
    const entry = { id: 'daily-brief', schedule: '0 8 * * *', skill: 'brief', enabled: true };

    expect(verbRoutine(base, JSON.stringify(entry))).toEqual({ status: 'added', id: 'daily-brief' });
    expect(verbRoutine(base, JSON.stringify({ ...entry, enabled: false }))).toEqual({ status: 'updated', id: 'daily-brief' });

    const config = JSON.parse(fs.readFileSync(path.join(base, 'config.json'), 'utf-8'));
    expect(config.routines).toHaveLength(1);
    expect(config.routines[0].enabled).toBe(false);
  }));

  test.each([
    ['malformed JSON', 'not json', { error: 'invalid_json' }],
    ['a JSON array', '[]', { error: 'invalid_json' }],
    ['a missing field', '{"id":"x","schedule":"* * * * *","skill":"brief"}', { error: 'missing_field:enabled' }],
    ['a blank id', '{"id":"","schedule":"* * * * *","skill":"brief","enabled":true}', { error: 'missing_field:id' }],
  ])('routine rejects %s', (_name, stdin, expected) => withDir(async (dir) => {
    expect(verbRoutine(seed(dir), stdin as string)).toEqual(expected);
  })());
});


test('header parsing preserves validation distinctions', () => {
  expect(grabHeader('Title: x\nNotTitle: y', 'Title')).toBe('x');
  expect(parseStringArray(null)).toEqual([]);
  expect(parseStringArray('["x"]')).toEqual(['x']);
  expect(parseStringArray('[1]')).toBeNull();
});
