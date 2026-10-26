// In-process tests for the scripts/proposal.ts write verbs.
//
// The companion file (proposal-write.test.ts) spawns the CLI and owns the
// process-boundary contract — argv, stdout grammar, exit codes. These call the
// verbs directly, which is what makes the grammar itself (header parsing, the
// EEXIST suffix walk, the `@now` idempotency guard) reachable per-case without
// a subprocess or an AGENT_DIR override. Keep contract assertions there and
// grammar assertions here.

import { describe, test, expect, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  verbCreate, verbPatch, verbResolve, verbRoutine,
  grabHeader, parseStringArray, sectionEndsWithLine,
} from '../scripts/proposal';
import { extractSection } from '../scripts/lib/md-write';
import { memoryDirFor } from '../scripts/lib/cc-compat';
import { PLUGIN_ROOT, runProposal, runScript } from './helpers/run';
import { withDir } from './helpers/workdir';

function stateDirOf(dir: string): string {
  return path.join(dir, '.hermit');
}

// withDir already makes sessions/ and state/; add what the create verb needs.
function seed(dir: string, config: Record<string, unknown> = {}): string {
  const base = stateDirOf(dir);
  fs.mkdirSync(path.join(base, 'proposals'), { recursive: true });
  fs.mkdirSync(path.join(base, 'templates'), { recursive: true });
  fs.copyFileSync(
    path.join(PLUGIN_ROOT, 'state-templates', 'PROPOSAL.md.template'),
    path.join(base, 'templates', 'PROPOSAL.md.template'),
  );
  fs.writeFileSync(
    path.join(base, 'config.json'),
    JSON.stringify({ timezone: 'Europe/London', routines: [], ...config }),
  );
  return base;
}

const BODY = [
  '## Context', 'ctx', '',
  '## Problem', 'prob', '',
  '## Operator Decision', '',
].join('\n');

function heredoc(header: Record<string, string>, body = BODY): string {
  return Object.entries(header).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n---\n' + body;
}

describe('verbCreate grammar', () => {
  test('happy path returns the canonical id and writes the file it names', withDir(async (dir) => {
    const base = seed(dir);
    const id = verbCreate(base, heredoc({ Title: 'Ship the thing', Tags: '["architecture"]' })).id;

    expect(id).toMatch(/^PROP-001-ship-thing-\d{6}$/);
    const content = fs.readFileSync(path.join(base, 'proposals', `${id}.md`), 'utf-8');
    expect(content).toContain(`id: ${id}`);
    expect(content).toContain('status: proposed');
    expect(content).toContain('tags: ["architecture"]');
    expect(content).toContain(`# Proposal: ${id} — Ship the thing`);
  }));

  test.each([
    ['no separator line', 'Title: x\nbody with no separator', { error: 'missing_separator' }],
    ['body is only whitespace', 'Title: x\n---\n   \n', { error: 'empty_body' }],
    ['no Title header', heredoc({ Source: 'manual' }), { error: 'missing_title' }],
    ['Title present but blank', heredoc({ Title: '   ' }), { error: 'missing_title' }],
    ['category outside the enum', heredoc({ Title: 'x', Category: 'wishlist' }), { error: 'invalid_category' }],
    ['Tags is not JSON', heredoc({ Title: 'x', Tags: 'architecture' }), { error: 'invalid_tags' }],
    ['Tags is JSON but not string[]', heredoc({ Title: 'x', Tags: '[1,2]' }), { error: 'invalid_tags' }],
    ['Related-Sessions is malformed', heredoc({ Title: 'x', 'Related-Sessions': '{}' }), { error: 'invalid_related_sessions' }],
  ])('%s', (_name, stdin, expected) => withDir(async (dir) => {
    const base = seed(dir);
    expect(verbCreate(base, stdin)).toEqual(expected);
    expect(fs.readdirSync(path.join(base, 'proposals'))).toEqual([]);
  })());

  test('a bare `Session:` header yields null without a runtime session ID', withDir(async (dir) => {
    const base = seed(dir);
    fs.writeFileSync(path.join(base, 'state', 'runtime.json'), JSON.stringify({}));

    const id = verbCreate(base, heredoc({ Title: 'x', Session: '' })).id;
    expect(fs.readFileSync(path.join(base, 'proposals', `${id}.md`), 'utf-8')).toContain('session: null');
  }));

  test('an absent Operator Decision section is appended so patch has somewhere to write', withDir(async (dir) => {
    const base = seed(dir);
    const id = verbCreate(base, heredoc({ Title: 'x' }, '## Context\nctx')).id;
    expect(fs.readFileSync(path.join(base, 'proposals', `${id}.md`), 'utf-8')).toContain('## Operator Decision');
  }));

  test('a missing template fails before any write', withDir(async (dir) => {
    const base = seed(dir);
    fs.rmSync(path.join(base, 'templates', 'PROPOSAL.md.template'));
    expect(verbCreate(base, heredoc({ Title: 'x' }))).toEqual({ error: 'template_missing' });
    expect(fs.readdirSync(path.join(base, 'proposals'))).toEqual([]);
  }));

  // Only reachable in production when two processes claim the same number at the
  // same second — the race the exclusive-create loop exists to absorb. Forcing
  // one EEXIST is what an in-process caller can do that a spawned CLI cannot.
  test('an EEXIST on the first exclusive write walks to the -a suffix', withDir(async (dir) => {
    const base = seed(dir);
    const real = fs.writeFileSync;
    let thrown = false;
    const spy = spyOn(fs, 'writeFileSync').mockImplementation(((...args: any[]) => {
      if (!thrown && args[2]?.flag === 'wx') {
        thrown = true;
        const e: any = new Error('EEXIST'); e.code = 'EEXIST'; throw e;
      }
      return (real as any)(...args);
    }) as any);

    try {
      const id = verbCreate(base, heredoc({ Title: 'Racing create' })).id;
      expect(thrown).toBe(true);
      expect(id).toMatch(/^PROP-001-racing-create-\d{6}a$/);
      expect(fs.existsSync(path.join(base, 'proposals', `${id}.md`))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }));
});

describe('verbPatch grammar', () => {
  function seedProposal(dir: string): { base: string; id: string } {
    const base = seed(dir);
    const id = verbCreate(base, heredoc({ Title: 'Patch me' })).id;
    return { base, id };
  }

  test('frontmatter set and Operator Decision append land in one write', withDir(async (dir) => {
    const { base, id } = seedProposal(dir);
    const verdict = verbPatch(base, 'Decision: Accepted on @now.', [id, '--set', 'status=accepted']);

    expect(verdict).toEqual({ id });
    const content = fs.readFileSync(path.join(base, 'proposals', `${id}.md`), 'utf-8');
    expect(content).toContain('status: accepted');
    expect(content).toMatch(/Accepted on \d{4}-\d{2}-\d{2}T[\d:]{8}[+-]\d{2}:\d{2}\./);
  }));

  test('re-applying the same @now decision line is idempotent', withDir(async (dir) => {
    const { base, id } = seedProposal(dir);
    const stdin = 'Decision: Accepted on @now.';
    verbPatch(base, stdin, [id]);
    verbPatch(base, stdin, [id]);

    const content = fs.readFileSync(path.join(base, 'proposals', `${id}.md`), 'utf-8');
    expect(content.match(/Accepted on /g)?.length).toBe(1);
  }));

  test.each([
    ['a parent-dir escape', '../config.json'],
    ['a nested path', 'sub/PROP-001.md'],
    ['a dotfile', '.hidden.md'],
    ['an absent proposal', 'PROP-999-nope.md'],
  ])('%s is refused as no_such_proposal', (_name, filename) => withDir(async (dir) => {
    const base = seed(dir);
    const before = fs.readFileSync(path.join(base, 'config.json'), 'utf-8');
    expect(verbPatch(base, '', [filename, '--set', 'status=accepted'])).toEqual({ error: 'no_such_proposal' });
    expect(fs.readFileSync(path.join(base, 'config.json'), 'utf-8')).toBe(before);
  })());

  test('a --set with no `=` is rejected', withDir(async (dir) => {
    const { base, id } = seedProposal(dir);
    expect(verbPatch(base, '', [id, '--set', 'statusaccepted'])).toEqual({ error: 'invalid_set' });
  }));

  test('an invalid key is rejected before the file is touched, decision line included', withDir(async (dir) => {
    const { base, id } = seedProposal(dir);
    const propPath = path.join(base, 'proposals', `${id}.md`);
    const before = fs.readFileSync(propPath, 'utf-8');

    expect(verbPatch(base, 'Decision: Accepted on @now.', [id, '--set', 'sta tus=accepted']))
      .toEqual({ error: 'invalid_key:sta tus' });
    expect(fs.readFileSync(propPath, 'utf-8')).toBe(before);
  }));

  test('--request-compact writes the marker alongside the patch', withDir(async (dir) => {
    const { base, id } = seedProposal(dir);
    verbPatch(base, '', [id, '--set', 'status=resolved', '--request-compact']);

    const marker = JSON.parse(fs.readFileSync(path.join(base, 'state', 'compact-requested.json'), 'utf-8'));
    expect(marker.reason).toBe('proposal-resolve');
  }));
});

describe('verbResolve', () => {
  function seedProposal(dir: string, sets: string[] = []): { base: string; id: string; file: string } {
    const base = seed(dir);
    const id = verbCreate(base, heredoc({ Title: 'Resolve me', Source: 'auto-detected' })).id;
    if (sets.length) verbPatch(base, '', [id, ...sets.flatMap(kv => ['--set', kv])]);
    return { base, id, file: path.join(base, 'proposals', `${id}.md`) };
  }
  // Rows after the `created` row verbCreate writes.
  function ledger(base: string): Record<string, unknown>[] {
    return fs.readFileSync(path.join(base, 'state', 'proposal-metrics.jsonl'), 'utf-8')
      .trim().split('\n').map(l => JSON.parse(l)).filter(r => r.type !== 'created');
  }

  test('a proposed, unanswered proposal records the accept before resolving', withDir(async (dir) => {
    const { base, id, file } = seedProposal(dir);
    expect(verbResolve(base, 'Decision: Resolved on @now.', `${id}.md`)).toEqual({ id });

    expect(ledger(base).map(r => [r.type, r.action])).toEqual([['responded', 'accept'], ['resolved', undefined]]);
    const content = fs.readFileSync(file, 'utf-8');
    expect(content).toContain('status: resolved');
    expect(content).toContain('responded: true');
    expect(content).toMatch(/accepted_date: \d{4}-/);
    expect(content).toMatch(/resolved_date: \d{4}-/);
    expect(content).toMatch(/Resolved on \d{4}-\d{2}-\d{2}T/);
    expect(fs.existsSync(path.join(base, 'state', 'compact-requested.json'))).toBe(true);
  }));

  test('a proposed proposal already answered gets the accept date but no second responded row', withDir(async (dir) => {
    const { base, id, file } = seedProposal(dir, ['responded=true']);
    expect(verbResolve(base, '', id)).toEqual({ id });

    expect(ledger(base).map(r => r.type)).toEqual(['resolved']);
    expect(fs.readFileSync(file, 'utf-8')).toMatch(/accepted_date: \d{4}-/);
  }));

  test.each(['accepted', 'deferred'])('a %s proposal gets only the resolved row', (status) => withDir(async (dir) => {
    const { base, id, file } = seedProposal(dir, [`status=${status}`, 'responded=true']);
    const acceptedBefore = /accepted_date: (.*)/.exec(fs.readFileSync(file, 'utf-8'))![1];
    expect(verbResolve(base, '', id)).toEqual({ id });

    expect(ledger(base).map(r => r.type)).toEqual(['resolved']);
    const content = fs.readFileSync(file, 'utf-8');
    expect(content).toContain('status: resolved');
    expect(/accepted_date: (.*)/.exec(content)![1]).toBe(acceptedBefore);
  })());

  test('a proposal with no Operator Decision section writes nothing', withDir(async (dir) => {
    const base = seed(dir);
    const file = path.join(base, 'proposals', 'PROP-014-bare.md');
    const original = '---\ntitle: Bare\nstatus: proposed\nresponded: false\n---\n\n## Context\n';
    fs.writeFileSync(file, original);

    expect(verbResolve(base, '', 'PROP-014-bare.md')).toEqual({ error: 'no_operator_decision_section' });
    expect(fs.readFileSync(file, 'utf-8')).toBe(original);
    expect(fs.existsSync(path.join(base, 'state', 'proposal-metrics.jsonl'))).toBe(false);
  }));

  test.each(['../config.json', 'sub/PROP-001.md', '.hidden.md', 'PROP-999-nope.md'])(
    '%s is refused as no_such_proposal', (filename) => withDir(async (dir) => {
      expect(verbResolve(seed(dir), '', filename)).toEqual({ error: 'no_such_proposal' });
    })());

  // `created` rows carry the full file id and answer rows the bare PROP-NNN, so both readers
  // must join on the short id for any accept to reach its source.
  test('a resolve from proposed counts in the source acceptance of both metrics readers', withDir(async (dir) => {
    const { base, id } = seedProposal(dir);
    expect(id).toMatch(/^PROP-\d+-./);
    fs.writeFileSync(path.join(base, 'state', 'alert-state.json'), '{}'); // the summary writes only on an installed hermit
    const accepted = async () => {
      const r = await runProposal(base, ['metrics', '--source=reflect']);
      return JSON.parse(r.stdout).accepted;
    };
    expect(await accepted()).toBe(0);
    expect(verbResolve(base, '', id)).toEqual({ id });
    expect(await accepted()).toBe(1);
    expect(fs.readFileSync(path.join(base, 'state', 'state-summary.md'), 'utf-8')).toContain('auto_detect_accept_rate: 1.00');
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

describe('proposal.ts anchor', () => {
  test('prints root and memory_dir when proposals/ is present', withDir(async (dir) => {
    const base = seed(dir);
    const r = await runProposal(base, ['anchor']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      JSON.stringify({ root: path.resolve(base), memory_dir: memoryDirFor(path.dirname(base)) }) + '\n',
    );
  }));

  test('prints root and memory_dir and writes no index when proposals/ is absent', withDir(async (dir) => {
    const base = seed(dir);
    fs.rmSync(path.join(base, 'proposals'), { recursive: true });
    const r = await runProposal(base, ['anchor']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      JSON.stringify({ root: path.resolve(base), memory_dir: memoryDirFor(path.dirname(base)) }) + '\n',
    );
    expect(fs.existsSync(path.join(base, 'state', 'proposals-index.json'))).toBe(false);
  }));

  // A worktree session passes the shipped relative spelling, which resolves to the
  // worktree's projected `.hermit` (config.json, no state/). The pin
  // normalizes it back to main; the anchor must name main, not the projection —
  // the projection would pass the agents' config.json blindness check while every
  // real source sits in main.
  test('names the main root when argv is a worktree projection', withDir(async (dir) => {
    const base = seed(dir);
    const projection = path.join(dir, 'wt', '.hermit');
    fs.mkdirSync(projection, { recursive: true });
    fs.writeFileSync(path.join(projection, 'config.json'), '{}');
    const r = await runScript('proposal.ts', {
      args: ['anchor', projection],
      env: { AGENT_DIR: base },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      JSON.stringify({ root: path.resolve(base), memory_dir: memoryDirFor(path.dirname(base)) }) + '\n',
    );
  }));

  test('exit 1 with foreign_state_dir on a drifted argv', withDir(async (dir) => {
    const base = seed(dir);
    const foreign = path.join(dir, 'elsewhere', '.hermit');
    fs.mkdirSync(foreign, { recursive: true });
    const r = await runScript('proposal.ts', {
      args: ['anchor', foreign],
      env: { AGENT_DIR: base },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toStartWith('{"error":"foreign_state_dir:');
  }));
});

describe('header and section helpers', () => {
  test('grabHeader trims its value and matches only at line start', () => {
    expect(grabHeader('Title:   spaced   \nSource: manual', 'Title')).toBe('spaced');
    expect(grabHeader('Not-Title: x', 'Title')).toBe(null);
  });

  test('parseStringArray separates "absent" from "malformed"', () => {
    expect(parseStringArray(null)).toEqual([]);
    expect(parseStringArray('  ')).toEqual([]);
    expect(parseStringArray('["a","b"]')).toEqual(['a', 'b']);
    expect(parseStringArray('[1]')).toBe(null);
    expect(parseStringArray('nope')).toBe(null);
  });

  test('sectionEndsWithLine treats @now as a timestamp wildcard', () => {
    const doc = '## Operator Decision\n\nAccepted on 2026-08-13T23:45:01+01:00.\n';
    expect(sectionEndsWithLine(doc, 'Operator Decision', 'Accepted on @now.')).toBe(true);
    expect(sectionEndsWithLine(doc, 'Operator Decision', 'Deferred on @now.')).toBe(false);
    expect(sectionEndsWithLine(doc, 'Missing Section', 'Accepted on @now.')).toBe(false);
  });
});
