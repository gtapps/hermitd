import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { freshDirFactory } from './helpers/workdir';
import { transcriptDirFor, memoryDirFor } from '../scripts/lib/cc-compat';
import { exportDream, INPUT_MAX_BYTES, NIGHT_MAX_BYTES } from '../scripts/dream';

const { freshDir, cleanup } = freshDirFactory('dream-');
afterAll(cleanup);
const now = Date.parse('2026-11-08T01:00:00Z');
const at = (n = 0) => new Date(now - 10_000 + n).toISOString();
const user = (text: string, n = 0) => ({ type: 'user', timestamp: at(n), message: { content: text } });
const agent = (text: string, n = 1) => ({ type: 'assistant', timestamp: at(n), message: { content: text } });
function fixture() {
  const root = freshDir(), dir = path.join(root, '.hermit'), config = path.join(root, 'cc');
  const memory = memoryDirFor(root, config), transcripts = transcriptDirFor(root, config);
  // An explicit project git root isolates the fixture from /tmp ancestors.
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(memory, { recursive: true });
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'compiled'));
  // Explicit empty settings avoid sandbox EACCES for absent configuration paths.
  for (const file of [path.join(config, 'settings.json'), path.join(root, '.claude/settings.json'),
    path.join(root, '.claude/settings.local.json'), path.join(dir, 'claude-settings.json')]) {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{}');
  }
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ channels: { discord: { shared_chats: [42] } } }));
  const write = (name: string, text: string) => { const file = path.join(transcripts, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const lines = (name: string, entries: any[]) => write(name, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  const execute = (fn: () => any) => {
    const prev = process.env.CLAUDE_CONFIG_DIR, project = process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
    process.env.CLAUDE_CONFIG_DIR = config; delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
    try { return fn(); } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
      if (project === undefined) delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME; else process.env.CLAUDE_CODE_PROJECT_DIR_NAME = project;
    }
  };
  const run = () => execute(() => exportDream(dir, now));
  const readState = () => JSON.parse(fs.readFileSync(path.join(dir, 'state/dream.json'), 'utf8'));
  const text = (out: any) => out.inputs.map((p: string) => fs.readFileSync(p, 'utf8')).join('');
  return { root, dir, config, memory, transcripts, write, lines, run, execute, readState, text };
}

describe('dream export', () => {
  test('snapshot hashes, default audience, permissions and partial last line', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.memory, 'MEMORY.md'), 'Original');
    fs.writeFileSync(path.join(f.dir, 'compiled/topic-a.md'), 'Topic');
    fs.writeFileSync(path.join(f.dir, 'compiled/other.md'), 'Other');
    f.write('one.jsonl', JSON.stringify(user('hello')) + '\n' + JSON.stringify(agent('answer')) + '\n' + JSON.stringify(user('partial')));
    const out = f.run(); expect(out.status).toBe('ready');
    expect(f.text(out)).toContain('AUDIENCE: shared\nUSER: hello');
    expect(f.text(out)).not.toContain('partial');
    const manifest = JSON.parse(fs.readFileSync(path.join(out.run_dir, 'manifest.json'), 'utf8'));
    expect(manifest.files['memory/MEMORY.md']).toBe(createHash('sha256').update('Original').digest('hex'));
    expect(Object.keys(manifest.files)).toEqual(['memory/MEMORY.md', 'compiled/topic-a.md']);
    expect(fs.statSync(out.inputs[0]).mode & 0o777).toBe(0o600);
    expect(f.run()).toEqual({ status: 'skipped', reason: 'run_in_progress' });
  });
  test('abandoned lock restores before starting again', () => {
    const f = fixture(); fs.writeFileSync(path.join(f.memory, 'fact.md'), 'before');
    f.lines('one.jsonl', [user('hello')]); const first = f.run();
    fs.writeFileSync(path.join(f.memory, 'fact.md'), 'after');
    const state = f.readState(); state.running.started_at = new Date(now - 3 * 3_600_000).toISOString();
    fs.writeFileSync(path.join(f.dir, 'state/dream.json'), JSON.stringify(state));
    expect(f.run().status).toBe('ready');
    expect(fs.readFileSync(path.join(f.memory, 'fact.md'), 'utf8')).toBe('before');
    expect(fs.readFileSync(path.join(f.dir, 'state/dream-log.jsonl'), 'utf8')).toContain('abandoned');
    expect(first.run_dir).toBeDefined();
  });
  test('unresolved memory and heartbeat-only windows', () => {
    const f = fixture(); fs.writeFileSync(path.join(f.config, 'settings.json'), '{"autoMemoryDirectory":"custom"}');
    expect(f.run()).toEqual({ status: 'skipped', reason: 'memory_dir_unresolved' });
    fs.writeFileSync(path.join(f.config, 'settings.json'), '{}');
    f.lines('one.jsonl', [user('HEARTBEAT_EVALUATE'), agent('heartbeat result')]);
    expect(f.run()).toEqual({ status: 'empty' });
  });
  test('dream co-fire and recursively launched agents are excluded', () => {
    const f = fixture();
    const launch = (id: string, n: number) => ({ ...agent('launch', n), toolUseResult: { status: 'async_launched', agentId: id } });
    f.lines('one.jsonl', [user('ROUTINE_DUE [hermit-routine:other] [hermit-routine:hermitd:dream]'), launch('a', 1), user('keep', 8)]);
    f.lines('one/subagents/agent-a.jsonl', [user('hidden-a'), launch('b', 2)]);
    f.lines('one/subagents/agent-b.jsonl', [user('hidden-b')]);
    f.lines('one/subagents/agent-c.jsonl', [user('hidden-c')]);
    const old = path.join(f.dir, 'state/dream/old'); fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, 'agents.jsonl'), '{"agent_id":"c"}\n');
    const out = f.run(); expect(f.text(out)).toContain('keep'); expect(f.text(out)).not.toContain('hidden');
  });
  test('single dream turns are excluded and queued commands open turns with channel audiences', () => {
    const f = fixture();
    f.lines('one.jsonl', [user('[hermit-routine:hermitd:dream] Run dream'), agent('discard'),
      { type: 'attachment', timestamp: at(2), attachment: { type: 'queued_command', prompt: '<channel source="discord" chat_id="42">shared</channel>' } },
      agent('shared answer', 3), user('<channel source="discord" chat_id="99">private</channel>', 4)]);
    const text = f.text(f.run()); expect(text).not.toContain('discard');
    expect(text).toContain('AUDIENCE: shared\nUSER: <channel'); expect(text).toContain('AUDIENCE: discord:99');
  });
  test('all recalled-memory surfaces are omitted', () => {
    const f = fixture(); const entries: any[] = [user('start')];
    for (const [i, name] of ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Skill'].entries()) {
      entries.push({ type: 'assistant', timestamp: at(i * 2 + 1), message: { content: [{ type: 'tool_use', id: String(i), name,
        input: name === 'Skill' ? { skill: 'hermitd:recall' } : { file_path: path.join(f.memory, 'fact.md'), path: f.memory, content: 'secret-write' } }] } });
      entries.push({ type: 'user', timestamp: at(i * 2 + 2), message: { content: [{ type: 'tool_result', tool_use_id: String(i), content: 'secret-result' }] } });
    }
    for (const [i, type] of ['file', 'edited_text_file'].entries()) entries.push({ type: 'attachment', timestamp: at(20 + i), attachment: { type, filename: path.join(f.dir, 'compiled/topic-a.md'), content: 'secret-attachment' } });
    f.lines('one.jsonl', entries); const text = f.text(f.run());
    expect(text).toContain('(memory content omitted:'); expect(text).not.toContain('secret-');
    expect(text).toContain('TOOL RESULT (Read):');
  });
  test('oversized transcripts split and the night ceiling keeps the last exported timestamp', () => {
    const f = fixture();
    const entries = [user('start')];
    for (let i = 0; i < 10; i++) entries.push(agent('x'.repeat(270_000), i + 1));
    f.lines('one.jsonl', entries); const out = f.run();
    expect(out.inputs.length).toBeGreaterThan(1); expect(out.pending).toBe(true);
    const sizes = out.inputs.map((file: string) => fs.statSync(file).size);
    expect(sizes.every((size: number) => size <= INPUT_MAX_BYTES)).toBe(true);
    expect(sizes.reduce((a: number, b: number) => a + b, 0)).toBeLessThanOrEqual(NIGHT_MAX_BYTES);
    const exported = JSON.parse(fs.readFileSync(path.join(out.run_dir, 'export.json'), 'utf8'));
    expect(exported.window_end).toBe(at(7));
  });
  test('completion notices take the launching turn audience and dream notices are dropped', () => {
    const f = fixture();
    const launch = (id: string, n: number) => ({ ...agent('launch', n), toolUseResult: { status: 'async_launched', agentId: id } });
    const notice = (id: string, body: string, n: number) => ({ ...user(`<task-notification>\n<task-id>${id}</task-id>\n<result>${body}</result>\n</task-notification>`, n), origin: { kind: 'task-notification' } });
    f.lines('one.jsonl', [user('<channel source="discord" chat_id="99">private</channel>'), launch('p', 1),
      user('[hermit-routine:hermitd:dream] Run dream', 2), launch('d', 3),
      notice('p', 'private-result', 4), agent('relayed', 5), notice('d', 'dream-result', 6), agent('dream-status', 7)]);
    const text = f.text(f.run());
    expect(text).toContain('AUDIENCE: discord:99\nUSER: <task-notification>');
    expect(text).toContain('private-result'); expect(text).not.toContain('AUDIENCE: shared');
    expect(text).not.toContain('dream-result'); expect(text).not.toContain('dream-status');
  });
  test('synchronous launches inherit the private audience and one oversized entry still exports', () => {
    const f = fixture();
    f.lines('one.jsonl', [user('<channel source="discord" chat_id="99">private</channel>'),
      { ...agent('launched', 1), toolUseResult: { status: 'completed', agentId: 's' } }]);
    f.lines('one/subagents/agent-s.jsonl', [user('sub task', 2), agent('y'.repeat(NIGHT_MAX_BYTES + 10), 3)]);
    const out = f.run(); const text = f.text(out);
    expect(text).toContain('AUDIENCE: discord:99\nUSER: sub task');
    expect(text).not.toContain('AUDIENCE: shared');
    for (const file of out.inputs) expect(fs.readFileSync(file, 'utf8')).toMatch(/^SESSION one\n(?:=== .*\n)?AUDIENCE: discord:99\n/);
    expect(out.pending).toBe(true);
    const g = fixture(); g.lines('one.jsonl', [user('z'.repeat(NIGHT_MAX_BYTES + 10), 3)]);
    const big = g.run(); expect(big.pending).toBe(false); expect(big.inputs.length).toBeGreaterThan(1);
    for (const file of big.inputs) expect(fs.readFileSync(file, 'utf8')).toMatch(/^SESSION one\nAUDIENCE: shared\n/);
  });
  test('a symlinked memory target skips without creating a run', () => {
    const f = fixture(); fs.symlinkSync(f.root, path.join(f.memory, 'link.md'));
    f.lines('one.jsonl', [user('hello')]);
    expect(f.run()).toEqual({ status: 'skipped', reason: 'symlink_target' });
    expect(fs.existsSync(path.join(f.dir, 'state/dream'))).toBe(false);
  });
});

import { finishDream, undoDream } from '../scripts/dream';
function prepare() {
  const f = fixture();
  fs.writeFileSync(path.join(f.memory, 'MEMORY.md'), '- [Fact](fact.md): one\n- [Role](feedback_role_test.md): [role discord:1] trusted\n');
  fs.writeFileSync(path.join(f.memory, 'fact.md'), 'First fact\nSecond fact\nThird fact\nFourth fact\n');
  fs.writeFileSync(path.join(f.memory, 'feedback_role_test.md'), 'Role fact\n');
  fs.writeFileSync(path.join(f.dir, 'compiled/topic-a.md'), '---\naudience: discord:1\ntags: [foundational]\n---\nPinned fact\n');
  f.lines('one.jsonl', [user('evidence'), agent('reply')]);
  const out = f.run();
  const stops = (analyzers = out.inputs.length) => {
    const rows = [...Array.from({ length: analyzers }, (_, i) => ({ agent_id: `a${i}`, agent_type: 'hermitd:dream-analyzer' })),
      { agent_id: 'o1', agent_type: 'hermitd:dream-organizer' }, { agent_id: 'o2', agent_type: 'hermitd:dream-organizer' }];
    fs.writeFileSync(path.join(out.run_dir, 'agents.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  };
  const finish = () => finishDream(f.dir, { inputs_expected: out.inputs.length, inputs_processed: out.inputs.length, failures: [], organized: true, index_entries: 2, changes: 1 });
  return { ...f, out, stops, finish };
}

describe('dream finish and undo', () => {
  for (const [name, mutate] of Object.entries({
    fact_loss: (f: ReturnType<typeof prepare>) => fs.writeFileSync(path.join(f.memory, 'fact.md'), 'Replacement A\nReplacement B\nReplacement C\nReplacement D\n'),
    role_file: (f: ReturnType<typeof prepare>) => fs.appendFileSync(path.join(f.memory, 'feedback_role_test.md'), 'changed'),
    role_index: (f: ReturnType<typeof prepare>) => fs.writeFileSync(path.join(f.memory, 'MEMORY.md'), '- [Fact](fact.md): one\n'),
    foundational: (f: ReturnType<typeof prepare>) => fs.unlinkSync(path.join(f.dir, 'compiled/topic-a.md')),
    foundational_line: (f: ReturnType<typeof prepare>) => fs.writeFileSync(path.join(f.dir, 'compiled/topic-a.md'), '---\naudience: discord:1\ntags: [foundational]\n---\nNew fact\n'),
    audience_change: (f: ReturnType<typeof prepare>) => fs.writeFileSync(path.join(f.dir, 'compiled/topic-a.md'), '---\naudience: shared\ntags: [foundational]\n---\nPinned fact\n'),
    audience_removal: (f: ReturnType<typeof prepare>) => fs.writeFileSync(path.join(f.dir, 'compiled/topic-a.md'), '---\ntags: [foundational]\n---\nPinned fact\n'),
  })) test(`${name} restores byte for byte and removes created files`, () => {
    const f = prepare(); const before = fs.readFileSync(path.join(f.memory, 'fact.md'));
    const start = f.readState().window_start;
    mutate(f); fs.writeFileSync(path.join(f.memory, 'new.md'), 'new'); f.stops();
    expect(f.finish().status).toBe('restored');
    expect(fs.readFileSync(path.join(f.memory, 'fact.md'))).toEqual(before);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.out.run_dir, 'manifest.json'), 'utf8'));
    for (const key of Object.keys(manifest.files)) {
      const target = key.startsWith('memory/') ? path.join(f.memory, key.slice(7)) : path.join(f.dir, key);
      expect(fs.readFileSync(target)).toEqual(fs.readFileSync(path.join(f.out.run_dir, 'before', key)));
    }
    expect(fs.existsSync(path.join(f.memory, 'new.md'))).toBe(false);
    expect(f.readState().window_start).toBe(start);
  });
  test('whitespace changes keep facts, all stops advance the window and finish is idempotent', () => {
    const f = prepare(); fs.writeFileSync(path.join(f.memory, 'fact.md'), ' First   fact \nSecond fact\nThird fact\nFourth fact\n');
    f.stops(); expect(f.finish().status).toBe('complete');
    expect(f.readState().window_start).toBe(at(2));
    expect(f.readState().running).toBeNull(); expect(f.finish()).toEqual({ status: 'noop' });
    expect(fs.existsSync(path.join(f.out.run_dir, 'inputs'))).toBe(false);
    expect(fs.readFileSync(path.join(f.dir, 'state/dream-log.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  });
  test('missing stop keeps the window and changes despite self-reported completion', () => {
    const f = prepare(); const start = f.readState().window_start;
    fs.appendFileSync(path.join(f.memory, 'fact.md'), 'Additional fact\n'); f.stops(0);
    expect(f.finish().status).toBe('partial'); expect(f.readState().window_start).toBe(start);
    expect(fs.readFileSync(path.join(f.memory, 'fact.md'), 'utf8')).toContain('Additional fact');
  });
  test('undo restores changed and removed files, deletes created files, and protects newer edits', () => {
    const f = prepare(); fs.appendFileSync(path.join(f.memory, 'fact.md'), 'Additional fact\n');
    fs.writeFileSync(path.join(f.memory, 'new.md'), 'new');
    fs.writeFileSync(path.join(f.memory, 'conflict.md'), 'dream');
    f.stops(); expect(f.finish().status).toBe('complete');
    fs.writeFileSync(path.join(f.memory, 'conflict.md'), 'operator');
    const out = undoDream(f.dir);
    expect(out.conflicts).toEqual(['memory/conflict.md']);
    expect(fs.existsSync(path.join(f.memory, 'new.md'))).toBe(false);
    expect(fs.readFileSync(path.join(f.memory, 'fact.md'), 'utf8')).not.toContain('Additional');
  });
  test('only seven run directories remain', () => {
    const f = prepare();
    for (let i = 0; i < 8; i++) fs.mkdirSync(path.join(f.dir, 'state/dream', `2026-01-0${i + 1}T00:00:00.000Z`));
    f.stops(); f.finish();
    expect(fs.readdirSync(path.join(f.dir, 'state/dream'))).toHaveLength(7);
  });
  test('a retired topic stub and a legacy page gaining audience shared both validate', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.dir, 'compiled/topic-old.md'), '---\naudience: discord:1\n---\nMerged fact\n');
    fs.writeFileSync(path.join(f.dir, 'compiled/topic-new.md'), '---\naudience: discord:1\n---\nOther fact\n');
    fs.writeFileSync(path.join(f.dir, 'compiled/topic-legacy.md'), 'Legacy fact\n');
    f.lines('one.jsonl', [user('evidence'), agent('reply')]);
    const out = f.run();
    fs.writeFileSync(path.join(f.dir, 'compiled/topic-new.md'), '---\naudience: discord:1\n---\nOther fact\nMerged fact\n');
    fs.writeFileSync(path.join(f.dir, 'compiled/topic-old.md'), 'MOVED TO [[topic-new]]');
    fs.writeFileSync(path.join(f.dir, 'compiled/topic-legacy.md'), '---\naudience: shared\n---\nLegacy fact\n');
    fs.writeFileSync(path.join(out.run_dir, 'agents.jsonl'), [{ agent_id: 'a', agent_type: 'hermitd:dream-analyzer' },
      { agent_id: 'o1', agent_type: 'hermitd:dream-organizer' }, { agent_id: 'o2', agent_type: 'hermitd:dream-organizer' }].map(r => JSON.stringify(r)).join('\n') + '\n');
    expect(finishDream(f.dir, {}).status).toBe('complete');
    expect(f.run()).toEqual({ status: 'empty' });
  });
});
