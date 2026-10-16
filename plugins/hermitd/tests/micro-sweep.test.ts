// Contract tests for `sweepMoot` (lib/proposals/micro.ts): retiring asks whose
// linked proposal reached a terminal status. The proposal-status writers run it
// in-process. The queue and the proposals dir are two stores with one
// relationship; these cases pin when the sweep is allowed to act on it and,
// more importantly, when it must not.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runProposal } from './helpers/run';
import { withDir } from './helpers/workdir';
import { sweepMoot } from '../scripts/lib/proposals/micro';

function stateArg(dir: string): string {
  return path.join(dir, '.hermit');
}

function seedProposal(dir: string, filename: string, status: string): void {
  const dest = path.join(stateArg(dir), 'proposals');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(
    path.join(dest, filename),
    ['---', 'title: "Seeded"', `status: ${status}`, '---', '', '## Operator Decision', ''].join('\n'),
  );
}

function seedQueue(dir: string, pending: any[]): void {
  const stateSub = path.join(stateArg(dir), 'state');
  fs.mkdirSync(stateSub, { recursive: true });
  fs.writeFileSync(path.join(stateSub, 'micro-proposals.json'), JSON.stringify({ pending }, null, 2) + '\n');
}

function readQueue(dir: string): any[] {
  return JSON.parse(fs.readFileSync(path.join(stateArg(dir), 'state', 'micro-proposals.json'), 'utf-8')).pending;
}

function ledger(dir: string): any[] {
  const p = path.join(stateArg(dir), 'state', 'proposal-metrics.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function ask(id: string, extra: Record<string, any> = {}): any {
  return {
    id, tier: 1, status: 'pending', follow_up_count: 0, ts: '2026-08-21T13:48:35Z',
    question: 'Suggestion #1 accepted — how should it be implemented?',
    options: ['implement now', 'session task', 'manual'],
    ...extra,
  };
}

const LINKED = { proposal_id: 'PROP-005', on_resolve: '/hermitd:proposal-act accept PROP-005 --answer {answer}' };

describe('sweepMoot: retires asks whose proposal settled', () => {
  for (const status of ['resolved', 'dismissed', 'deferred']) {
    test(`${status} proposal sweeps its linked ask`, withDir(async (dir) => {
      seedProposal(dir, 'PROP-005-seeded-013132.md', status);
      seedQueue(dir, [ask('MP-20260821-0', LINKED)]);

      expect(sweepMoot(stateArg(dir), 'PROP-005')).toEqual({ ok: true, swept: ['MP-20260821-0'] });
      expect(readQueue(dir)).toHaveLength(0);

      const events = ledger(dir).filter(e => e.type === 'micro-resolved');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        micro_id: 'MP-20260821-0', action: 'moot', proposal_id: 'PROP-005', proposal_status: status,
      });
    }));
  }

  test('sweeps every ask linked to the proposal, one ledger line each', withDir(async (dir) => {
    seedProposal(dir, 'PROP-005-a-013132.md', 'resolved');
    seedProposal(dir, 'PROP-006-b-013132.md', 'dismissed');
    seedQueue(dir, [
      ask('MP-1', LINKED),
      ask('MP-2', { proposal_id: 'PROP-005', question: 'Another ask?' }),
      ask('MP-3', { proposal_id: 'PROP-006' }),
    ]);

    expect(sweepMoot(stateArg(dir), 'PROP-005').swept).toEqual(['MP-1', 'MP-2']);
    expect(readQueue(dir).map(e => e.id)).toEqual(['MP-3']);
    expect(ledger(dir).filter(e => e.action === 'moot')).toHaveLength(2);
  }));

  test('legacy entry links through the accept callback alone', withDir(async (dir) => {
    seedProposal(dir, 'PROP-005-seeded-013132.md', 'resolved');
    seedQueue(dir, [ask('MP-legacy', { on_resolve: '/hermitd:proposal-act accept PROP-005 --answer {answer}' })]);

    expect(sweepMoot(stateArg(dir), 'PROP-005').swept).toEqual(['MP-legacy']);
  }));

  test('legacy slug-less PROP-NNN.md filename still matches', withDir(async (dir) => {
    seedProposal(dir, 'PROP-005.md', 'resolved');
    seedQueue(dir, [ask('MP-1', LINKED)]);

    expect(sweepMoot(stateArg(dir), 'PROP-005').swept).toEqual(['MP-1']);
  }));

  test('an unpadded legacy id resolves to the padded filename', withDir(async (dir) => {
    seedProposal(dir, 'PROP-019-seeded-013132.md', 'resolved');
    seedQueue(dir, [ask('MP-1', { on_resolve: '/hermitd:proposal-act accept PROP-19 --answer {answer}' })]);

    expect(sweepMoot(stateArg(dir), 'PROP-019').swept).toEqual(['MP-1']);
  }));
});

describe('sweepMoot: leaves everything else alone', () => {
  const untouched = (dir: string, proposalId = 'PROP-005') => {
    expect(sweepMoot(stateArg(dir), proposalId)).toEqual({ ok: true, swept: [] });
    expect(readQueue(dir)).toHaveLength(1);
    expect(ledger(dir).filter(e => e.type === 'micro-resolved')).toHaveLength(0);
  };

  for (const status of ['accepted', 'proposed']) {
    test(`a ${status} proposal keeps its ask pending`, withDir(async (dir) => {
      seedProposal(dir, 'PROP-005-seeded-013132.md', status);
      seedQueue(dir, [ask('MP-1', LINKED)]);
      untouched(dir);
    }));
  }

  test('an unlinked ask is never swept', withDir(async (dir) => {
    seedProposal(dir, 'PROP-005-seeded-013132.md', 'resolved');
    seedQueue(dir, [ask('MP-1')]);
    untouched(dir);
  }));

  // on_resolve is free-form (channel-responder lets any skill set it), so a
  // PROP id merely occurring inside some other command is not a declared link.
  test('a PROP id outside the accept callback is not a link', withDir(async (dir) => {
    seedProposal(dir, 'PROP-005-seeded-013132.md', 'resolved');
    seedQueue(dir, [ask('MP-1', { on_resolve: '/hermitd:hermit-settings quality-gate --answer {answer} # see PROP-005' })]);
    untouched(dir);
  }));

  test('PROP-1 does not match PROP-12', withDir(async (dir) => {
    seedProposal(dir, 'PROP-012-other-013132.md', 'resolved');
    seedQueue(dir, [ask('MP-1', { proposal_id: 'PROP-1' })]);
    untouched(dir, 'PROP-1');
  }));

  test('an ambiguous double match is never destructive', withDir(async (dir) => {
    seedProposal(dir, 'PROP-005-first-013132.md', 'resolved');
    seedProposal(dir, 'PROP-005-second-013133.md', 'resolved');
    seedQueue(dir, [ask('MP-1', LINKED)]);
    untouched(dir);
  }));

  test('a missing proposal file leaves the ask pending', withDir(async (dir) => {
    fs.mkdirSync(path.join(stateArg(dir), 'proposals'), { recursive: true });
    seedQueue(dir, [ask('MP-1', LINKED)]);
    untouched(dir);
  }));

  test('a frontmatterless proposal leaves the ask pending', withDir(async (dir) => {
    const dest = path.join(stateArg(dir), 'proposals');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'PROP-005-seeded-013132.md'), '# no frontmatter here\n');
    seedQueue(dir, [ask('MP-1', LINKED)]);
    untouched(dir);
  }));

  test('an already-resolved row is left for brief-cycle to prune', withDir(async (dir) => {
    seedProposal(dir, 'PROP-005-seeded-013132.md', 'resolved');
    seedQueue(dir, [ask('MP-1', { ...LINKED, status: 'answered' })]);
    untouched(dir);
  }));

  test('a corrupt queue is refused, not overwritten', withDir(async (dir) => {
    seedProposal(dir, 'PROP-005-seeded-013132.md', 'resolved');
    const qp = path.join(stateArg(dir), 'state', 'micro-proposals.json');
    fs.mkdirSync(path.dirname(qp), { recursive: true });
    const corrupt = '{"pending": [ {"id": "MP-1",} ]}\n';
    fs.writeFileSync(qp, corrupt);

    expect(sweepMoot(stateArg(dir), 'PROP-005').ok).toBe(false);
    expect(fs.readFileSync(qp, 'utf-8')).toBe(corrupt);
  }));

  test('no queue file at all is a clean no-op', withDir(async (dir) => {
    seedProposal(dir, 'PROP-005-seeded-013132.md', 'resolved');
    expect(sweepMoot(stateArg(dir), 'PROP-005')).toEqual({ ok: true, swept: [] });
  }));
});

describe('queue-micro — proposal_id link and dedup', () => {
  const queue = (dir: string, payload: object) =>
    runProposal(stateArg(dir), ['queue-micro'], { stdin: JSON.stringify(payload) });

  test('stores proposal_id and dedups on it despite reworded questions', withDir(async (dir) => {
    fs.writeFileSync(path.join(stateArg(dir), 'config.json'), JSON.stringify({ timezone: 'UTC' }));
    const first = await queue(dir, {
      tier: 1, question: 'Suggestion #1 accepted — how should it be implemented?',
      on_resolve: '/hermitd:proposal-act accept PROP-005 --answer {answer}', proposal_id: 'PROP-005',
    });
    const { status, id } = JSON.parse(first.stdout);
    expect(status).toBe('queued');
    expect(id).toMatch(/^MP-/);
    expect(readQueue(dir)[0].proposal_id).toBe('PROP-005');

    // Same proposal, different display index — the old exact-question dedup
    // would have queued a second ask for one decision.
    const second = await queue(dir, {
      tier: 1, question: 'Suggestion #4 accepted — how should it be implemented?',
      on_resolve: '/hermitd:proposal-act accept PROP-005 --answer {answer}', proposal_id: 'PROP-005',
    });
    expect(JSON.parse(second.stdout)).toEqual({ status: 'duplicate', id });
    expect(readQueue(dir)).toHaveLength(1);
  }));

  test('unlinked asks keep exact-question dedup', withDir(async (dir) => {
    fs.writeFileSync(path.join(stateArg(dir), 'config.json'), JSON.stringify({ timezone: 'UTC' }));
    const first = await queue(dir, { tier: 2, question: 'Same question?' });
    const { id } = JSON.parse(first.stdout);
    expect(JSON.parse((await queue(dir, { tier: 2, question: 'Same question?' })).stdout)).toEqual({ status: 'duplicate', id });
    expect(JSON.parse((await queue(dir, { tier: 2, question: 'Different question?' })).stdout).status).toBe('queued');
    expect(readQueue(dir)).toHaveLength(2);
  }));

  test('a malformed proposal_id is dropped, not fatal', withDir(async (dir) => {
    fs.writeFileSync(path.join(stateArg(dir), 'config.json'), JSON.stringify({ timezone: 'UTC' }));
    const r = await queue(dir, { tier: 1, question: 'q?', proposal_id: 'not-an-id' });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).status).toBe('queued');
    expect(readQueue(dir)[0].proposal_id).toBeUndefined();
  }));
});
