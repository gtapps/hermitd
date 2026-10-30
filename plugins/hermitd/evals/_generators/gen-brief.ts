// Generate the brief run-* and dispatch-* cases into evals/brief/.
//
// These drive the real /hermitd:brief against a busy seeded install, with the
// real read-only scripts, so a run can compare the runner dispatch with composing
// in main. Run from anywhere: bun evals/_generators/gen-brief.ts

import fs from 'node:fs';
import path from 'node:path';

import { EVALS, type Grader, USER, graderYaml, heredocs, indent, report, residentPrompt, residentScaffold, writeCase, yq } from './lib';

const OUT = path.join(EVALS, 'brief');
const CONFIG = { agent_name: 'assistant', timezone: 'UTC' };
const OPERATOR = '# Operator\n\nRuns a small online tea shop alone. Prefers short messages.\n';
const TODAY = '__TODAY__';

const WORK = ['supplier price list', 'autumn tea range', 'gift box stock', 'shipping rates', 'newsletter draft', 'returns policy',
  'tasting notes', 'wholesale invoices', 'loose leaf labels', 'courier contract', 'storefront photos', 'loyalty discounts',
  'matcha reorder', 'tax summary', 'packaging samples', 'customer survey', 'holiday calendar', 'blend recipes', 'stock count', 'review replies'];

const ACTION = (w: string) => `Update the ${w}`;
const RESULT = (w: string) => `The ${w} is finished: every entry was checked against the source documents, the two mismatches found on the first pass were corrected, `
  + `and the final version was saved to the shop folder with a short note on what moved since last month, so the next pass can start from a clean baseline.`;
const LESSON = (w: string, i: number) => `2026-10-2${i % 8}T11:00:00.000Z: The ${w} takes longer when the source spreadsheet is exported as text, so export it as a table first and compare row counts before editing anything.`;
const DECISION = (w: string, i: number) => `2026-10-2${i % 8}T12:00:00.000Z hermit: Kept the existing structure of the ${w} because the operator reads it on a phone and a new layout would not fit.`;

type Kind = 'done-today' | 'cancelled-today' | 'done-earlier' | 'waiting' | 'unconfirmed' | 'open';

function record(i: number, kind: Kind): [string, string] {
  const w = WORK[i];
  const id = `T-20261001-${String(100000 + i)}`;
  const cancelled = kind === 'cancelled-today';
  const closed = kind === 'done-today' || cancelled || kind === 'done-earlier';
  // Just after midnight, so a close stamped today is never later than the run's clock.
  const closedAt = kind === 'done-earlier' ? '2026-10-20T16:00:00.000Z' : `${TODAY}T00:${String(10 + i)}:00.000Z`;
  const result = kind === 'done-today' || kind === 'done-earlier' || kind === 'unconfirmed' ? RESULT(w) : null;
  const waiting = kind === 'waiting' ? `discord:${USER}` : null;
  const front = [`id: ${id}`, 'type: task', `title: "${ACTION(w)}"`, 'created: 2026-10-20T09:00:00.000Z', `summary: "${ACTION(w)} from the current sources"`,
    `audience: discord:${USER}`, `status: ${closed ? 'closed' : 'open'}`, 'opened_at: 2026-10-20T09:00:00.000Z', `requester: discord:${USER}`,
    `handle: update-${i}`, 'owner: resident', `closed_at: ${closed ? closedAt : 'null'}`,
    `closed_by: ${closed ? (cancelled ? 'cancelled' : 'confirmed') : 'null'}`, 'closed_actor: null',
    `closed_reason: ${closed ? (cancelled ? '"Operator dropped it, the supplier closed"' : '"Confirmed by the operator"') : 'null'}`,
    'requester_name: null', 'origin_message_id: null', 'approver: null', 'due: null', `conversation: discord:${USER}`, 'card_chat_id: null', 'card_message_id: null',
    `waiting_on: ${waiting ?? 'null'}`, `waiting_since: ${waiting ? '2026-10-21T10:00:00.000Z' : 'null'}`, `result: ${result ? JSON.stringify(result) : 'null'}`,
    `result_at: ${result ? '2026-10-21T10:00:00.000Z' : 'null'}`, 'stall_at: null', 'stall_status: null', 'stall_next: null', 'dedupe_key: null', 'check: null',
    'skill_review: null', 'last_worker: null', 'muted: false', 'delegated: false', 'tags: ["task"]', 'claims: []', 'result_rev: 0'];
  const lessons = [0, 1, 2].map(n => `- ${LESSON(w, i + n)}`).join('\n');
  const decisions = [0, 1].map(n => `- ${DECISION(w, i + n)}`).join('\n');
  return [`.hermit/tasks/${id}.md`, `---\n${front.join('\n')}\n---\n## Progress\n- 2026-10-20T09:00:00.000Z hermit: Opened\n\n## Lessons\n${lessons}\n\n## Decisions\n${decisions}\n`];
}

const KINDS: Kind[] = ['done-today', 'done-today', 'done-today', 'done-today', 'done-today', 'cancelled-today', 'done-today', 'done-today',
  'waiting', 'waiting', 'unconfirmed', 'open', 'open', 'open', 'done-earlier', 'done-earlier', 'done-earlier', 'done-earlier', 'done-earlier', 'done-earlier'];

const busyInstall = (kinds: Kind[] = KINDS) => Object.fromEntries(kinds.map((k, i) => record(i, k)));

const BUSY = busyInstall();
const changes = (install: Record<string, string>) => Object.fromEntries(Object.entries(install).filter(([p, body]) => body !== BUSY[p]));

// Every case sources one seed and writes only the records it changes.
fs.mkdirSync(path.join(OUT, '_seed'), { recursive: true });
fs.writeFileSync(path.join(OUT, '_seed', 'busy.sh'), residentScaffold(CONFIG, { '.hermit/OPERATOR.md': OPERATOR, ...BUSY }));

/** Seeded dates must match the run's day, since task-report selects by the live clock. */
const scaffold = (delta: Record<string, string>) => ['#!/usr/bin/env bash', '# Seeds the shared busy install plus this case\'s changes (runs only with --scaffold).', 'set -e',
  'here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"', '. "$here/../_seed/busy.sh"', ...heredocs(delta),
  `sed -i "s/${TODAY}/$(date -u +%F)/g" .hermit/tasks/*.md`, ''].join('\n');

/** A resumable transcript: the turns, then `BRIEF_HISTORY_KB` of filler to size the main context for a cost comparison. */
function history(turns: [string, string][]): string {
  const filler = Number(process.env.BRIEF_HISTORY_KB ?? 0);
  // One pad exchange is about 5 KB on disk.
  const pad: [string, string][] = Array.from({ length: Math.ceil(filler / 5) }, (_, i) =>
    [`Note ${i} for the shop log: ${'stock moved between shelves and the counts were recorded. '.repeat(70)}`, 'Noted.']);
  const session = '00000000-0000-4000-8000-000000000001';
  let parent: string | null = null;
  return [...pad, ...turns].flat().map((text, i) => {
    const uuid = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
    const role = i % 2 ? 'assistant' : 'user';
    const line = { type: role, uuid, parentUuid: parent, sessionId: session, timestamp: '2026-10-20T08:00:00.000Z', cwd: '/workspace', version: '2.1.314',
      message: role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }], model: 'claude-sonnet-5-5', id: `msg_${i}`, type: 'message', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } };
    parent = uuid;
    return JSON.stringify(line);
  }).join('\n') + '\n';
}

function runCase(name: string, tags: string[], desc: string, prompt: string, graders: Grader[], delta: Record<string, string> = {}, transcript?: string): void {
  const y = ['schema_version: "1.1"', `name: ${name}`, `description: ${yq(desc)}`, `tags: [${tags.join(', ')}]`,
    'context:', '  scaffold_script: scaffold.sh', ...(transcript ? ['  history_file: history.jsonl'] : []), 'execution:', '  max_turns: 24', '  timeout_seconds: 420',
    '  allowed_tools: [Skill, Read, Glob, Grep, Bash, Agent, Write]', '  env: {EVAL_HERMIT_RESIDENT: "1"}',
    '  append_system_prompt: |', indent(residentPrompt()), '  prompt: |', indent(prompt), 'graders:', ...graders.map(graderYaml)];
  const dir = path.join(OUT, name);
  writeCase(dir, y, scaffold(delta));
  if (transcript) fs.writeFileSync(path.join(dir, 'history.jsonl'), transcript);
}

const dispatchedRunner: Grader = { name: 'dispatched-runner', type: 'tool_used', tool: 'Agent', input_match: 'skill-eval-runner' };
const present = (name: string, pattern: string): Grader => ({ name, type: 'regex', target: 'last_message', pattern, flags: 'i', weight: 2 });
const absent = (name: string, pattern: string): Grader => ({ ...present(name, pattern), match: 'not_contains' });

const WHOLE_REPORT = absent('whole-report-read', 'cut off|truncated|only read');
const TRUE_STATE = [present('waiting-labels', 'loose leaf labels'), present('waiting-courier', 'courier contract'), present('unconfirmed-photos', 'storefront photos'),
  present('runnable-work', 'matcha reorder'), present('finished-work', 'gift box stock'), WHOLE_REPORT];
const EVENING = 'Invoke /hermitd:brief --evening';
const DAILY = 'Invoke /hermitd:brief, the daily summary: brief today.';

for (const [mode, prompt] of [['evening', EVENING], ['daily', DAILY]] as const) {
  runCase(`dispatch-${mode}-busy`, ['brief-dispatch'], `A busy ${mode} brief dispatches the runner.`, prompt, [dispatchedRunner]);
  runCase(`run-${mode}-busy`, ['brief-run'], `A busy ${mode} brief states outcomes from the records.`, prompt, TRUE_STATE);
}
runCase('run-default-no-session', ['brief-run'], 'No flag and no open records: a one-screen brief of the newest record.', 'Invoke /hermitd:brief',
  [present('status-completed', 'status\\W+completed'), present('newest-record', 'wholesale invoices'), WHOLE_REPORT],
  changes(busyInstall(KINDS.map(k => (k === 'done-today' || k === 'cancelled-today' ? k : 'done-earlier')))));

const [firstPath, firstRecord] = record(0, KINDS[0]);
runCase('run-contradicted-lesson', ['brief-run'], 'A lesson the final result disproved stays out of the evening findings.', EVENING,
  [absent('no-contradicted-lesson', 'does not work on the new spreadsheet'), present('finished-work', 'price list'), WHOLE_REPORT],
  { [firstPath]: firstRecord
    .replace('## Lessons\n', '## Lessons\n- 2026-10-20T11:00:00.000Z: The price list import does not work on the new spreadsheet.\n')
    .replace(/result: "[^\n]*"/, 'result: "The price list import worked on the new spreadsheet, every row imported and verified."') });

const STALE = ACTION('gift box stock');
runCase('run-stale-context', ['brief-run'], 'Earlier conversation says closed work is waiting; the brief follows the records.', EVENING,
  [absent('no-stale-waiting', 'waiting[^\\n]*gift box|gift box stock\\W+(result\\s+)?(still\\s+|stays\\s+|is\\s+)*a?waiting'),
    absent('no-denied-record', 'no gift box|gift box stock\\W+(it\\s+)?(isn.t|is not)\\s+in\\b'), present('finished-work', 'gift box stock'), WHOLE_REPORT],
  {}, history([['Where do things stand?', `Waiting on you: ${STALE}, I need your decision on the gift box count before I can finish it.`],
    ['I will get back to you on the gift box stock.', `Understood. ${STALE} stays waiting on your reply.`]]));

report('brief');
