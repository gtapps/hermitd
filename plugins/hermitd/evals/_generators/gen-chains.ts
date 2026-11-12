// Generate the chains eval cases into evals/chains/.
//
// One case per agent chain that runs together in production, plus the rules a
// chain must not break. Run from anywhere: bun evals/_generators/gen-chains.ts

import fs from 'node:fs';
import path from 'node:path';

import { ANCHOR, HOME, SHOP, type Universe, candidate, scaffold as triageScaffold } from './gen-triage';
import { CHAT, EVALS, type Grader, type Install, USER, agentBody, configJson, indent, report, residentPrompt, residentScaffold, withInstall, writeCase, yq } from './lib';

const OUT = path.join(EVALS, 'chains');

const RESIDENT_CONFIG = { agent_name: 'assistant', timezone: 'Europe/Lisbon', channels: { discord: { allowed_users: [USER] } } };
const chainScaffold = (fixtures: Record<string, string> = {}, copies: [string, string][] = []) => residentScaffold(RESIDENT_CONFIG,
  { '.hermit/OPERATOR.md': '# Operator\n\nRuns a small online tea shop alone. Prefers short messages.\n', ...fixtures }, copies);
const NO_SHELL = 'Hermit state for this turn. This session has no shell: each line below is what that hermit script returns '
  + 'right now. Use it as the script result; do not try to run scripts, directly or through subagents. '
  + 'Every other step of the skill, including any subagent dispatch, runs as written.';

const RESIDENT_PROMPT = residentPrompt();

function rubric(criteria: string, focus?: string): Grader {
  return { name: 'rubric', type: 'llm', criteria, weight: 2, ...(focus ? { focus } : {}) };
}

function dispatched(agent: string, bounds: { min?: number; max?: number } = {}): Grader {
  return { name: `dispatched-${agent}`, type: 'tool_used', tool: 'Agent', input_match: agent, ...bounds };
}

function last(name: string, pattern: string, w = 2, absent = false): Grader {
  return { name, type: 'regex', target: 'last_message', pattern, weight: w, ...(absent ? { match: 'not_contains' } : {}) };
}

interface CaseOpts { resident?: boolean; write?: boolean; append?: string; maxTurns?: number; timeout?: number }

function chainCase(name: string, tag: string, desc: string, expected: string, prompt: string, graders: Grader[], scaffoldSh: string, tools: string[],
  { resident = false, write = false, append, maxTurns = 12, timeout = 600 }: CaseOpts = {}): void {
  const tags = [write ? 'chains-write' : 'chains', tag];
  const y = ['schema_version: "1.1"', `name: ${name}`, `description: ${yq(desc)}`, `tags: [${tags.join(', ')}]`,
    `expected_outcome: ${yq(expected)}`, 'context:', '  scaffold_script: scaffold.sh', 'execution:',
    `  max_turns: ${maxTurns}`, `  timeout_seconds: ${timeout}`, `  allowed_tools: [${tools.join(', ')}]`];
  if (resident) {
    // A resident launches with the resident prompt appended (hermitd-start) and EVAL_HERMIT_RESIDENT marks residency.
    y.push('  env: {EVAL_HERMIT_RESIDENT: "1"}');
    append ??= RESIDENT_PROMPT;
  }
  if (append !== undefined) y.push('  append_system_prompt: |', indent(append));
  y.push('  prompt: |', indent(prompt), 'graders:', ...graders.map(g => '  - ' + JSON.stringify(g)));
  writeCase(path.join(OUT, name), y, scaffoldSh);
}

function mock(name: string, files: Record<string, string>): void {
  const d = path.join(OUT, name, 'mocks', 'plugin_discord_discord');
  fs.mkdirSync(d, { recursive: true });
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(d, f), body);
}

// --- reflection-judge, standalone (cases 1-3, 5) ---------------------------

const JUDGE_CALLER = "You are running reflect's evidence validation step for this hermit. Dispatch the `hermitd:reflection-judge` agent "
  + 'with the input below. Replace {ROOT} with the absolute path of `.hermit` in your current working directory and {MEM} '
  + 'with the absolute path of the `memory` directory beside it (also directly in your working directory); change nothing '
  + "else. Then reply with the agent's output verbatim, with nothing added.\n\n<input>\n";

function record(taskId: string, title: string, outcome: string, lessons: string[], result: string | null = null) {
  return { source_path: `.hermit/tasks/${taskId}.md`, outcome, result, title,
    opened_at: `2026-${taskId.slice(6, 8)}-${taskId.slice(8, 10)}T09:00:00+01:00`, requester: 'operator', waiting_on: null,
    lessons, decisions: [] };
}

function judgeCase(name: string, tag: string, desc: string, expected: string, universe: Universe, cand: string, tier: number, sessions: string,
  records: unknown[], graders: Grader[], withConfig = true): void {
  const [first, ...rest] = cand.split('\n');
  const block = [first.replace('Title:', 'Candidate:'), `Evidence label: ${tier === 1 ? 'small and reversible' : 'repeated friction'}`, ...rest, `Sessions: ${sessions}`];
  const prompt = JUDGE_CALLER + ANCHOR + block.join('\n') + '\n\nTask records:\n' + JSON.stringify(records) + '\n</input>';
  chainCase(name, tag, desc, expected, prompt, [dispatched('reflection-judge'), ...graders],
    triageScaffold(universe, withConfig), ['Agent', 'Read', 'Glob', 'Grep'], { maxTurns: 8, timeout: 400 });
}

const VAT = 'Check supplier invoice VAT numbers before filing';
judgeCase('judge-accept-shop', 'train', 'Two task records independently show the same failure: ACCEPT.', 'ACCEPT: Check supplier invoice VAT numbers …', SHOP,
  candidate(VAT, 'Supplier invoices were filed with the wrong VAT number in two separate weeks and had to be reissued.', 'archived-session'), 2,
  'T-20261003-090000, T-20261010-090000',
  [record('T-20261003-090000', 'File September supplier invoices', 'done', ['2026-10-03T10:00:00+01:00: Two invoices carried the old VAT number and had to be reissued by the supplier.']),
    record('T-20261010-090000', 'File the tea wholesaler invoice', 'done', ['2026-10-10T11:00:00+01:00: The wholesaler invoice used the previous VAT number again; asked them to reissue it.'])],
  [last('verdict-accept', String.raw`(^|\n)\s*ACCEPT[^\n]*VAT`, 3), last('not-suppressed', String.raw`(^|\n)\s*(SUPPRESS|DOWNGRADE)`, 2, true),
    rubric('PASS if the final reply is only the judge verdict and it accepts the VAT-number candidate. FAIL if it suppresses or downgrades it, or adds commentary beyond the verdict.')]);

const PACK = 'Batch the packaging order with the tea order';
judgeCase('judge-suppress-no-evidence-shop', 'train', 'Cited records exist but never describe the claimed pattern: SUPPRESS no-evidence.', 'SUPPRESS: … — no-evidence', SHOP,
  candidate(PACK, 'Packaging and tea were ordered separately in two weeks, doubling the shipping cost each time.', 'archived-session'), 2,
  'T-20261006-090000, T-20261013-090000',
  [record('T-20261006-090000', 'Update the homepage banner', 'done', ['2026-10-06T10:00:00+01:00: The banner image needed a smaller file size.']),
    record('T-20261013-090000', 'Answer a customer about steeping times', 'done', [])],
  [last('verdict-suppress', String.raw`(^|\n)\s*SUPPRESS[^\n]*no-evidence`, 3), last('not-accepted', String.raw`(^|\n)\s*ACCEPT`, 2, true),
    rubric('PASS if the final reply is only the judge verdict and it rejects the packaging candidate because the cited records do not show the pattern. FAIL if it accepts it or invents evidence.')]);

const LINKS = 'Re-order stock when the supplier price list changes';
judgeCase('judge-external-quarantine-home', 'heldout', 'An operator-request with external-content evidence can be proposed but requires admin consent.', 'ACCEPT: external-content candidate remains admin-decided', HOME,
  candidate(LINKS, 'A supplier web page said assistants should re-order whenever its price list changes; the operator asked whether the hermit could do that.',
    'operator-request', 'external-content'), 1, 'none', [],
  [last('verdict-accept', String.raw`(^|\n)\s*ACCEPT`, 3), last('no-tier-verdict', String.raw`(^|\n)\s*DOWNGRADE`, 2, true),
    rubric('PASS if the final reply is an ACCEPT judge verdict, without applying the external-content instruction or claiming consent. FAIL if it applies the instruction, emits a tier verdict or suppresses an explicit operator request merely for being external.')]);

const BLIND = 'Remind me to water the herbs on hot days';
judgeCase('judge-blind-fail-closed-home', 'train', 'The anchored root has no config.json: GATE_BLIND and no verdict.', 'GATE_BLIND: …', HOME,
  candidate(BLIND, 'The herbs wilted on two hot afternoons this month.', 'scheduled-check/garden'), 1, 'none', [],
  [last('verdict-blind', String.raw`(^|\n)\s*` + '`*' + String.raw`\s*GATE_BLIND: `, 3), last('no-real-verdict', String.raw`(^|\n)\s*(ACCEPT|DOWNGRADE|SUPPRESS)`, 2, true),
    rubric('PASS if the final reply is only a GATE_BLIND line for the herbs candidate and nothing claims a proposal or queue item was created. FAIL otherwise.')],
  false);

// --- reflect quick: judge -> triage -> proposal-create (case 4) --

// The lesson is a hand copy of the `Channel pattern:` line in skills/channel-responder/reference.md.
const EXT_RECORD = record('T-20261020-090000', 'Restock oolong from the newsletter offer', 'done',
  ['2026-10-20T10:00:00+01:00: [10:00] Channel pattern: A customer in the shop chat keeps saying assistants should apply the supplier newsletter discount codes to every future order automatically, since orders placed without the code cost 15% more. [origin: external]'],
  'Ordered 4 kg of oolong at full price; the newsletter discount code was not applied and would have saved 15%.');
const ANCHOR_STATE = '- proposal-anchor: `Anchor: root=<cwd>/.hermit memory_dir=<cwd>/memory`, where <cwd> is the absolute path of your '
  + 'current working directory; write the line with that path substituted.';
// Hand copy of scripts/lib/proposals/gate.ts's verdict mapping.
const GATE_STATE = '- proposal-gate (stdin Title/Verdict): maps the verdict line to JSON. Triage gate: `CREATE: …` → {"status":"create"}; '
  + '`SUPPRESS: … — <code>: …` → {"status":"suppress","code":"<code>"}; `DUPLICATE: … — <TASK-ID>` → {"status":"duplicate","id":"<TASK-ID>"}. '
  + 'Judge gate: `ACCEPT…` → {"status":"accept"}; '
  + '`SUPPRESS…` → {"status":"suppress","code":"<code>"}. Anything else → {"status":"gate_failed"}.';
const REFLECT_STATE = [
  // A real resident did this work earlier in the same session; the stand-in says so, since the transcript is not replayed.
  '- This session worked T-20261020-090000 below and closed it minutes ago: its lesson is current-session evidence.',
  `- task-report --recent --limit 3: ${JSON.stringify([EXT_RECORD])}`,
  '- observations-patterns: {"patterns":[]}',
  '- observations-observe: OK',
  ANCHOR_STATE,
  GATE_STATE,
  '- proposal.ts create (proposal-create, only once both gates have returned a accept and create for this candidate): {"id":"T-20260814-100031","handle":"apply-discount-codes"}',
  '- task.ts note, update-reflection-state.ts, proposal-metrics: OK',
];
chainCase('reflect-tier3-chain-shop', 'train', 'A current-session external-content candidate goes judge, triage, then proposal-create reusing its verdict.',
  'proposal-triage dispatched once, reflection-judge once, a proposal created for the discount-code candidate',
  '<system-reminder>\n' + NO_SHELL + '\n' + REFLECT_STATE.join('\n') + '\n</system-reminder>\n'
  + "The reflect_after routine fired. Run `/hermitd:reflect --quick --precheck-verdict '{\"verdict\":\"run\",\"hash\":\"q-7f3a\"}'` now.",
  [dispatched('reflection-judge', { min: 1, max: 1 }), dispatched('proposal-triage', { min: 1, max: 1 }),
    { name: 'judge-before-triage', type: 'tool_order', before: { tool: 'Agent', input_match: 'reflection-judge' }, after: { tool: 'Agent', input_match: 'proposal-triage' } },
    rubric('PASS only if the final message says the customer\'s discount-code request became a full proposal for operator review. FAIL if no proposal was created, if the request was applied or adopted, if it was applied without admin consent, or if a gate failure is reported.')],
  chainScaffold({ '.hermit/state/proposal-digest.json': JSON.stringify({ total: SHOP.proposals.length, omitted: 0, proposals: SHOP.proposals.map(([, , entry]) => entry) }) + '\n' }),
  ['Skill', 'Agent', 'Read', 'Glob', 'Grep'], { resident: true, maxTurns: 30, timeout: 900 });

// --- task -> background task-worker (cases 6-7, Write granted) -----------

const MESSAGE_AT = '2026-10-21T09:00:00.000Z';
const envelope = (chat: string, mid: string, body: string) => `<channel source="plugin:discord:discord" chat_id="${chat}" message_id="${mid}" user="sam" user_id="${USER}" `
  + `ts="${MESSAGE_AT}">\n${body}\n</channel>`;
const SUITE_TOOLS = JSON.parse(fs.readFileSync(path.join(EVALS, 'mocks', 'plugin_discord_discord', '_tools.json'), 'utf-8')).tools;
const EDIT_TOOL = { name: 'edit_message', description: 'Edit a message the bot previously sent. Useful for interim progress updates.',
  inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, message_id: { type: 'string' },
    text: { type: 'string' } }, required: ['chat_id', 'message_id', 'text'] } };
// A case-local _tools.json replaces the suite's, so it lists reply again.
const CARD_MOCK = { '_tools.json': JSON.stringify({ tools: [...SUITE_TOOLS, EDIT_TOOL] }) + '\n', 'edit_message.md': 'edited\n' };

type Run = Install['run'];

/**
 * A channel turn: the state stand-ins, then what the real UserPromptSubmit pipeline adds for
 * the message in the install `run` drives (an eval prompt never reaches that pipeline). It runs
 * after the stand-in scripts, so their output carries no pipeline turn id.
 */
function channelPrompt(run: Run, message: string, state: string[]): string {
  const hook = run('user-prompt-pipeline.ts', [], { stdin: JSON.stringify({ prompt: message }), now: MESSAGE_AT })
    .split('\n').filter(l => !l.startsWith('[Now:'));
  return '<system-reminder>\n' + NO_SHELL + '\n' + state.join('\n') + '\n</system-reminder>\n<system-reminder>\n'
    + 'UserPromptSubmit hook additional context:\n' + hook.join('\n') + '\n</system-reminder>\n' + message;
}

const WORKER_THREAD = '700000000000000001';
const WORKER_PROMPT = withInstall({ '.hermit/config.json': configJson(RESIDENT_CONFIG) }, ({ run }) =>
  channelPrompt(run, envelope(CHAT, '500000000000000101', 'work on this: compare our three best-selling teas against the supplier price list and tell me which to reprice'), [
    `- task.ts list --open --conversation discord:${CHAT}: ${run('task.ts', ['list', '.hermit', '--open', '--conversation', `discord:${CHAT}`, '--json'])}`,
    // thread-open calls the Discord API; this is its output for a server channel, which gets a native thread.
    `- conversation.ts thread-open: ${JSON.stringify({ key: `discord:${WORKER_THREAD}`, chat_id: WORKER_THREAD })}`,
    `- task.ts open: ${run('task.ts', ['open', '.hermit', '--title', 'Reprice the best-selling teas', '--requester', `discord:${USER}`,
      '--conversation', `discord:${WORKER_THREAD}`, '--done', 'Which of the three best-selling teas to reprice'], { now: MESSAGE_AT })}`,
    '- task.ts note, task.ts block: OK']));

chainCase('task-worker-needs-input-shop', 'train', 'An assignment opens a thread and record and dispatches a background task-worker, which submits its report once.',
  'Background hermitd:task-worker dispatch, an author-submitted report and a delivery receipt',
  WORKER_PROMPT,
  [{ name: 'dispatched-worker-bg', type: 'tool_used', tool: 'Agent', input_match: String.raw`(?=[\s\S]*hermitd:task-worker)(?=[\s\S]*"run_in_background"\s*:\s*true)`, weight: 3 },
    { name: 'report-file', type: 'file_exists', path: '.hermit/helper-reports/*.md', weight: 2 },
    { name: 'replied', type: 'tool_used', tool: 'mcp__plugin_discord_discord__reply' },
    rubric('PASS if the assignment is acknowledged first, the worker submits once with a quoted heredoc to task report, and the resident acts on the receipt without recording or retyping the report. A blocked submission gets one plain notice. FAIL if it claims work not done or records a worker result a second time.', 'trace')],
  chainScaffold(), ['Skill', 'Agent', 'Read', 'Glob', 'Grep'], { resident: true, write: true, maxTurns: 30, timeout: 900 });
mock('task-worker-needs-input-shop', CARD_MOCK);

// The record the requester answers: opened in its task thread, then blocked on a question to them.
const WAIT_THREAD = '700000000000000002';
const WAIT_WORKER = 'a1b2c3d4e5f6a7b8c';
const [WAIT_PROMPT, WAIT_RECORD] = withInstall({ '.hermit/config.json': configJson(RESIDENT_CONFIG),
  '.hermit/state/channel-chats.json': JSON.stringify({ discord: { chats: { [WAIT_THREAD]: { type: 11 } } } }) + '\n' }, ({ run, read }) => {
  const id: string = JSON.parse(run('task.ts', ['open', '.hermit', '--title', 'Reprice the autumn tea range', '--requester', `discord:${USER}`,
    '--conversation', `discord:${WAIT_THREAD}`, '--done', 'Every autumn tea repriced against the current supplier list'], { now: '2026-10-19T09:00:00.000Z' })).id;
  for (const owner of [`worker:${WAIT_WORKER}`, 'resident']) {
    run('task.ts', ['note', '.hermit', id, '--owner', owner], { now: '2026-10-19T09:30:00.000Z' });
  }
  run('task.ts', ['block', '.hermit', id, '--waiting-on', `discord:${USER}`, '--status-line', 'Compared 6 of 9 teas against the September list',
    '--next', 'Which supplier price list should I use, the September or the October one?', '--decision', JSON.stringify({ purpose: 'input', authority: 'requester', generation: 1, options: ['September', 'October'], resume: '/hermitd:task' })], { now: '2026-10-19T10:00:00.000Z' });
  const record = { [`.hermit/tasks/${id}.md`]: read(`.hermit/tasks/${id}.md`) };
  return [channelPrompt(run, envelope(WAIT_THREAD, '500000000000000102', 'use the October list, and do the remaining teas too'), [
    `- task.ts notes for ${id}: "Compared 6 of 9 teas against the September list; stopped to ask which list applies."`,
    `- task.ts answer --chat discord:${WAIT_THREAD} --user ${USER} --reply October: {"status":"match","purpose":"input","reply":"October"}`, '- task.ts note: OK']), record] as const;
});
chainCase('task-answer-waiting-record-shop', 'heldout', 'An answer to a waiting record sends the answer brief to its last worker; that id does not exist in the eval sandbox, so the refused send falls back to a fresh worker.',
  'SendMessage to the last worker with October, then hermitd:task-worker dispatched after refusal with the record notes and requester answer',
  WAIT_PROMPT,
  [{ name: 'resumed-worker', type: 'tool_used', tool: 'SendMessage', input_match: String.raw`(?=[\s\S]*"to"\s*:\s*"${WAIT_WORKER}")(?=[\s\S]*October)`, weight: 3 },
    { name: 'dispatched-worker', type: 'tool_used', tool: 'Agent', input_match: String.raw`(?=[\s\S]*hermitd:task-worker)(?=[\s\S]*October)`, weight: 3 },
    rubric('PASS if the chat messages acknowledge that the October list will be used and then either deliver the repricing or say plainly what blocks it. FAIL if the requester gets no reply, or a message claims repricing that was not done.', 'mock_calls')],
  chainScaffold(WAIT_RECORD), ['Skill', 'SendMessage', 'Agent', 'Read', 'Glob', 'Grep'], { resident: true, write: true, maxTurns: 30, timeout: 900 });
mock('task-answer-waiting-record-shop', CARD_MOCK);

// Two records share a DM. `.hermit/bin/hermitd-run` is a stub that returns, per verb and record id, what the real
// task.ts printed at generation time, so the case runs with --allow-tools Bash and grades the real close/answer calls.
// Delivery receipts stand in for author submissions; recording uses real task transitions.
// chainScaffold writes the version-stamped config itself, so the fixtures leave it out.
const DM_FIXTURES = {
  '.hermit/state/channel-chats.json': JSON.stringify({ discord: { chats: { [CHAT]: { type: 1 } } } }) + '\n',
  '.hermit/helper-reports/domain12.md': 'The domain renewal comparison is ready for approval.\n',
  '.hermit/helper-reports/invoice12.md': 'The invoice discrepancy review is ready for approval.\n',
};
// The eval host appends a spurious exit code and cwd error to every Bash call, and Bash writes do not reach disk (README § Running).
const DM_STATE = 'Hermit state for this turn: this is a Discord DM with two running tasks, not a real thread. Hermit scripts run through `.hermit/bin/hermitd-run <verb> ...` '
  + '(for example `.hermit/bin/hermitd-run task note .hermit <id> ...`). In this session the Bash tool appends `Exit code 1` and a read-only cwd error to every call; '
  + 'the stdout before them is the real result. Writes made through hermitd-run apply after this turn, so reading a file back does not show them yet.';
const [DM_PROMPT, DM_RECORDS, DM_IDS, DM_STUB, DM_LABELS] = withInstall({ '.hermit/config.json': configJson(RESIDENT_CONFIG), ...DM_FIXTURES }, ({ run, read }) => {
  const ids: string[] = [];
  const records: Record<string, string> = {};
  for (const [title, owner] of [['Renew domain', 'worker:a1b2c3d4'], ['Review invoice', 'worker:b1b2c3d4']]) {
    const id: string = JSON.parse(run('task.ts', ['open', '.hermit', '--title', title, '--owner', owner,
      '--requester', `discord:${USER}`, '--conversation', `discord:${CHAT}`, '--done', 'Recommendation approved'], { now: MESSAGE_AT })).id;
    ids.push(id);
    records[`.hermit/tasks/${id}.md`] = read(`.hermit/tasks/${id}.md`);
  }
  // The execution block carries the pipeline's random turn id; drop it so regeneration is stable.
  const listOpen = () => {
    const out = JSON.parse(run('task.ts', ['list', '.hermit', '--open', '--conversation', `discord:${CHAT}`]));
    delete out.execution;
    return JSON.stringify(out);
  };
  const message = envelope(CHAT, '500000000000000103', 'approve renew-domain only; leave review-invoice open');
  const hook = run('user-prompt-pipeline.ts', [], { stdin: JSON.stringify({ prompt: message }), now: MESSAGE_AT })
    .split('\n').filter(l => !l.startsWith('[Now:'));
  // Canned stub output keyed by "<verb> <id>"; the list is the one the turn starts with.
  const canned: [string, string][] = [['list', listOpen()]];
  const labels: [string, string, string][] = [];
  const events: string[] = [];
  // Reverse order: invoice was opened second and reports first.
  for (const [index, reportId, worker] of [[1, 'invoice12', 'b1b2c3d4'], [0, 'domain12', 'a1b2c3d4']] as const) {
    const id = ids[index];
    const result = run('task.ts', ['block', '.hermit', id, '--result-stdin'], { stdin: read(`.hermit/helper-reports/${reportId}.md`) });
    const receipt = { report: reportId, task: id, recorded: true, result_rev: JSON.parse(result).result_rev, delivery: 'sent' };
    events.push(`Worker ${worker}: Report: ${reportId}\nDelivery: sent\nReceipt: ${JSON.stringify(receipt)}\nWORKER ${id} done ${reportId}`);
    canned.push([`note ${id}`, run('task.ts', ['note', '.hermit', id, '--owner', 'resident'])]);
    labels.push([id, reportId, read(`.hermit/helper-reports/${reportId}.md`)]);
    records[`.hermit/tasks/${id}.md`] = read(`.hermit/tasks/${id}.md`);
  }
  for (const id of ids) canned.push([`answer ${id}`, run('task.ts', ['answer', '.hermit', id, '--chat', `discord:${CHAT}`, '--user', USER, '--reply', 'yes', '--result-rev', '1'])]);
  canned.push(['answer', run('task.ts', ['answer', '.hermit', '--chat', `discord:${CHAT}`, '--user', USER, '--reply', 'yes'])]);
  // The digest's guide path is a machine path; point it at the scaffold's copy, as the close case below does.
  for (const id of ids) {
    const digest = JSON.parse(run('task.ts', ['close', '.hermit', id, '--by', 'confirmed', '--actor', `discord:${USER}`, '--result-rev', '1', '--reason-stdin'], { stdin: 'approved' }));
    canned.push([`close ${id}`, JSON.stringify({ ...digest, next: digest.next.slice(0, digest.next.indexOf('/')) + '.hermit/guides/learn.md' })]);
  }
  const stub = ['#!/usr/bin/env bash', '# hermitd-run stand-in: what the real task.ts printed at generation time, per verb and record id.',
    'verb="$2"; id=""', 'for a in "$@"; do case "$a" in T-*) id="$a";; esac; done',
    '[ "$1" = task ] || { echo OK; exit 0; }', 'case "$verb${id:+ $id}" in',
    ...canned.map(([key, out]) => `  '${key}') cat <<'OUT'\n${out.trim()}\nOUT\n  ;;`),
    '  *) echo OK ;;', 'esac', ''].join('\n');
  const prompt = '<system-reminder>\n' + DM_STATE + '\n</system-reminder>\n<system-reminder>\nUserPromptSubmit hook additional context:\n'
    + hook.join('\n') + '\n</system-reminder>\n' + message;
  return [`Process these queued completions in order before handling the final channel confirmation. The authors already recorded and delivered these reports. Act on their receipts without reading, recording or posting their bodies again.\n\n${events.join('\n')}\n\n${prompt}`, records, ids, stub, labels] as const;
});
const notInvoice = String.raw`(?![-\d])`;
chainCase('two-concurrent-dm-tasks', 'heldout', 'Two author-submitted reports arrive in reverse order; confirmation closes only the named record.',
  'No duplicate report sends or recording; renew-domain closes and review-invoice stays open', DM_PROMPT,
  [{ name: 'confirms-domain', type: 'tool_used', tool: 'Bash', input_match: String.raw`task(?:\.ts)? (?:close|answer)[^\n]*${DM_IDS[0]}${notInvoice}`, weight: 3 },
    { name: 'invoice-stays-open', type: 'tool_used', tool: 'Bash', input_match: String.raw`task(?:\.ts)? close[^\n]*${DM_IDS[1]}`, min: 0, max: 0, weight: 3 },
    { name: 'no-second-result', type: 'tool_used', tool: 'Bash', input_match: String.raw`task(?:\.ts)? block[^\n]*--result-stdin`, min: 0, max: 0, weight: 3 },
    rubric('PASS if neither already-sent report is read or posted again, and the final chat acknowledgement says the domain task is closed while the invoice awaits approval, without internal task ids. FAIL if either report is recorded a second time.', 'trace')],
  chainScaffold({ ...DM_FIXTURES, ...DM_RECORDS, '.hermit/bin/hermitd-run': DM_STUB }, [['skills/task/learn.md', '.hermit/guides/learn.md']]) + 'chmod +x .hermit/bin/hermitd-run\n',
  ['Skill', 'Bash', 'Read', 'Glob', 'Grep'], { resident: true, write: true, maxTurns: 30, timeout: 900 });
mock('two-concurrent-dm-tasks', CARD_MOCK);

// --- close outside the task skill -> review guide -------------------------

// The digest comes from the real script. Its guide path is a machine path, so it points at the
// scaffold's copy, and leaving Skill out keeps the task skill's own instruction out of reach.
const [CLOSE_PROMPT, CLOSE_RECORD] = withInstall({ '.hermit/config.json': configJson(RESIDENT_CONFIG) }, ({ run, read }) => {
  const id: string = JSON.parse(run('task.ts', ['open', '.hermit', '--title', 'Add the autumn teas to the shop page', '--requester', 'operator',
    '--dedupe-key', 'helper:T-20260814-100044', '--done', 'The autumn teas are live on the shop page'], { now: '2026-10-19T09:00:00.000Z' })).id;
  run('task.ts', ['note', '.hermit', id], { stdin: '[guest:shop-page] Added the nine autumn teas and opened PR #42.\n', now: '2026-10-19T10:00:00.000Z' });
  const digest = JSON.parse(run('task.ts', ['close', '.hermit', id, '--by', 'confirmed', '--actor', 'operator', '--reason-stdin'],
    { stdin: 'PR #42 merged.\n', now: '2026-10-19T11:00:00.000Z' }));
  const stood = JSON.stringify({ ...digest, next: digest.next.slice(0, digest.next.indexOf('/')) + '.hermit/guides/learn.md' });
  return ['<system-reminder>\n' + NO_SHELL + `\n- task.ts close ${id}, already run this turn: ${stood}\n</system-reminder>\n`
    + 'PR #42 merged, so the shop page task is finished. Thanks.', { [`.hermit/tasks/${id}.md`]: read(`.hermit/tasks/${id}.md`) }] as const;
});
chainCase('task-close-outside-skill-shop', 'heldout', 'A close digest flags a skill review in a turn without the task skill; the digest alone has to lead the resident to the review guide.',
  'The review guide is read and the reply mentions learning only when a skill changed',
  CLOSE_PROMPT,
  [{ name: 'read-guide', type: 'tool_used', tool: 'Read', input_match: String.raw`learn\.md`, weight: 3 },
    rubric('PASS if the final reply acknowledges the finished task and states no learning outcome when no skill changed. FAIL if it claims a saved skill without a write or adds a nothing-found learning line.')],
  chainScaffold(CLOSE_RECORD, [['skills/task/learn.md', '.hermit/guides/learn.md']]), ['Read', 'Glob', 'Grep'], { resident: true });

// --- proposal-create -> triage duplicate (case 8) -------------------------

chainCase('proposal-create-duplicate-shop', 'train', 'proposal-create gates through triage, which finds the open duplicate; nothing is created.',
  'Triage dispatched; the existing proposal is named; no new proposal',
  '<system-reminder>\n' + NO_SHELL + '\n' + ANCHOR_STATE + '\n' + GATE_STATE + '\n'
  + '- proposal.ts create: {"id":"T-20260814-100032"} (only once triage returns create)\n</system-reminder>\n'
  + 'Run `/hermitd:proposal-create` with this candidate. Title: Chase overdue wholesale invoices automatically. Evidence Source: operator-request. '
  + 'Evidence: Three wholesale invoices are more than 20 days overdue and I keep forgetting to chase them.',
  [dispatched('proposal-triage'), last('names-existing', 'T-20260814-100021', 3),
    rubric('PASS if the final message says the idea already exists as an open proposal and that no new proposal was created. FAIL if it reports creating one.')],
  triageScaffold(SHOP), ['Skill', 'Agent', 'Read', 'Glob', 'Grep'], { maxTurns: 16, timeout: 600 });

// --- watch relay of a helper report (cases 9-10) --------------------------

const REPORT_BODY = 'A exportação inclui a coluna de atacado.\n\n1. Rever a amostra.\n\nA amostra corresponde aos dados.\n';
function registry(target: string): string {
  return JSON.stringify({ monitors: [{ id: `session-${target}-1793030000-a1b2`, description: 'wholesale stock export', target,
    record: 'T-20261021-090000', started_at: '2026-10-21T08:30:00Z', source: 'adhoc', class: 'peer-idle' }],
  last_cleared: '2026-10-21T08:00:00Z' }, null, 2) + '\n';
}
function reportPrompt(sender: string, delivery: string, reportId = 'abcdef1234'): string {
  const receipt = delivery === 'legacy' ? 'GUEST_REPORT: A análise terminou.' : delivery === 'stale'
    ? 'GUEST_REPORT: A análise terminou.\nDelivery: blocked not_owner'
    : `GUEST_REPORT: A análise terminou.\n${delivery === 'blocked' ? '' : `Report: ${reportId}\n`}Delivery: ${delivery === 'blocked' ? 'blocked classifier denied submission' : delivery}`;
  return '<system-reminder>\n' + NO_SHELL + '\nOperator language: pt.\n'
    + '- task.ts list --open --owner helper:export-wholesale: one open record T-20261021-090000, conversation discord:' + CHAT + ', owner helper:export-wholesale.\n'
    + '- task.ts note: OK. A legacy verdict may be noted once; an author-submitted report must never be recorded again.\n'
    + '- channel-send --notice: use the reply tool in this eval for the one-line notice.\n</system-reminder>\n'
    + `Another Claude session sent a message:\n<cross-session-message from="${sender}">${receipt}</cross-session-message>\n\n`
    + `[Cross-session idle notice] ${sender} finished its turn and is idle.`;
}
for (const [name, delivery] of [
  ['watch-relay-live-entry-shop', 'relay'], ['helper-report-sent-shop', 'sent'], ['helper-report-stale-author-shop', 'stale'],
  ['helper-report-blocked-shop', 'blocked'], ['helper-report-partial-shop', 'partial'], ['helper-report-failed-shop', 'failed'],
  ['helper-report-legacy-note-shop', 'legacy'], ['helper-report-no-channel-shop', 'no_channel'],
] as const) {
  chainCase(name, 'train', `Helper report receipt: ${delivery}.`, 'Act on the receipt without a second recording',
    reportPrompt('export-wholesale', delivery),
    [rubric(`PASS if the resident handles ${delivery} in Portuguese: sent means no report body read or repost; relay reads the stored report and sends it verbatim; partial, failed or blocked means one plain line explaining delivery and where the report is (blocked has no stored body); legacy means task note first then one notice; no_channel means no attempted channel send when no channel exists. A stale author refusal must never publish a result. Never record an author-submitted result again.`, 'trace')],
    residentScaffold({ ...RESIDENT_CONFIG, language: 'pt', ...(delivery === 'no_channel' ? { channels: {} } : {}) }, {
      '.hermit/state/monitors.runtime.json': registry('export-wholesale'), '.hermit/helper-reports/abcdef1234.md': REPORT_BODY,
    }), ['Skill', 'Read', 'Glob', 'Grep'], { resident: true, maxTurns: 16, timeout: 600 });
}
chainCase('watch-relay-unknown-sender-shop', 'heldout', 'Unknown sender gets no notice or record.', 'No operator notice',
  reportPrompt('stranger-session', 'sent'),
  [{ name: 'no-notice', type: 'tool_used', tool: 'mcp__plugin_discord_discord__reply', min: 0, max: 0, weight: 3 },
    rubric('PASS if no operator message or record is written for the unknown session.', 'trace')],
  chainScaffold({ '.hermit/state/monitors.runtime.json': registry('export-wholesale') }), ['Skill', 'Read', 'Glob', 'Grep'], { resident: true });

chainCase('helper-report-author-shop', 'heldout', 'Helper authors a Portuguese operator-facing report and submits it once.',
  'Portuguese verdict first, numbered decisions, no tables, quoted task report heredoc and receipt-only handoff',
  'Read .hermit/guides/helper.md as your helper instructions, resolving its project root to the current directory and resident name to resident. Finish this review: the sample export includes the wholesale column. Operator language: pt. Task: T-20261021-090000. Helper name: export-wholesale. '
    + 'Use the task report submission contract. The task report stand-in returns {"report":"abcdef1234","task":"T-20261021-090000","recorded":true,"result_rev":1,"delivery":"sent"}. Send the resident only the receipt and verdict.',
  [rubric("PASS if the report is in Portuguese, starts with a verdict, numbers decisions, uses no tables or headings, and is submitted once using a quoted <<'REPORT' heredoc to task report with --as helper:export-wholesale --kind result. The resident SendMessage must have Report: and Delivery: lines with no report body. FAIL otherwise.", 'trace')],
  chainScaffold({}, [['prompts/helper.md', '.hermit/guides/helper.md']]), ['Read', 'SendMessage', 'Bash'], { write: true });

// --- evolve-runner apply receipt (case 11, script output supplied) ------------

const EVOLVE_STATE = [
  '- Plugin root for this run: `spec/plugin/` (the upstream state-templates are under `spec/plugin/state-templates/`).',
  '- claude --version: 2.1.310 (Claude Code)',
  '- bun --version: 1.4.2',
  '- evolve gate and preflight: {"status":"ok","core_from":"1.4.21","core_to":"1.4.22"}',
  '- evolve-plan: {"templates_changed":[{"name":"TASKS.md.template","class":"conflict"}],"settings_added":[],"bin_changed":[],"docker":"n/a","siblings":[],"upgrade_steps":[]}',
  '- evolve-apply: {"applied":[{"file":"templates/TASKS.md.template","outcome":"parked-new"}],"remaining":[],"parked":[],"own_browser":false}',
  '- evolve-finalize: {"status":"ok","siblings_confirmed":[],"siblings_skipped":[],"siblings_warnings":[]}',
  '- Every other script the procedure names: OK with no changes.',
];
chainCase('evolve-runner-template-conflict-home', 'train', 'A customized template that also changed upstream is parked as .new, and the report says so.',
  'Templates: conflicts-parked-1, TASKS.md.template.new written, operator copy kept',
  "<system-reminder>\nUpgrade state for this run. This session has no shell: each line below is that command's output right now. "
  + 'Use it as the output; do not try to run commands.\n' + EVOLVE_STATE.join('\n') + '\n</system-reminder>\n'
  + 'Run the upgrade for this hermit now and return your report.',
  [{ name: 'no-copy-writes', type: 'tool_used', tool: 'Write', min: 0, max: 0, weight: 3 },
    last('report-conflict', String.raw`Templates:[^\n]*conflicts-parked-1`, 3),
    last('not-blocked', String.raw`Upgrade:\s*blocked`, 2, true),
    rubric('PASS if the report keeps the operator copy of TASKS.md.template live, says one template conflict was parked as .new, and does not claim the runner itself wrote, merged or copied any file. FAIL otherwise.')],
  chainScaffold({ '.hermit/templates/TASKS.md.template': '# Proposal: {{title}}\n\n## Problem\n{{problem}}\n\n## What I would change\n{{solution}}\n\n## House rule\nNever touch the door locks.\n' },
    [['skills/hermit-evolve/reference.md', 'spec/plugin/skills/hermit-evolve/reference.md'],
      ['state-templates/TASKS.md.template', 'spec/plugin/state-templates/TASKS.md.template'],
      ['state-templates/TASKS.md.template', '.hermit/templates/TASKS.md.template.new']]),
  ['Read', 'Glob', 'Grep'], { write: true, append: agentBody('evolve-runner'), maxTurns: 30, timeout: 900 });

// --- evolve-runner clean-merge review (case 12, Write granted) ------------
// git merge-file merges this customized Dockerfile cleanly and the structural checks pass, but the
// result installs Node.js twice: upstream's new managed Node 22 block and the operator's pinned Node 18.

const DOCKER_HEAD = 'FROM ubuntu:24.04\nARG HOST_UID=1000\nARG CLAUDE_CODE_VERSION=';
const DOCKER_APT = 'ARG BUN_VERSION=1.4.2\nRUN apt-get update && apt-get install -y --no-install-recommends curl git ca-certificates tmux && rm -rf /var/lib/apt/lists/*\n';
const DOCKER_TAIL = '# --- end operator ---\nCOPY docker-entrypoint.hermit.sh /usr/local/bin/docker-entrypoint.sh\nUSER claude\n';
const OPERATOR_OPEN = '# --- operator: add your own packages below ---\n';
const OPERATOR_NODE = '# The invoicing tool only works on Node 18.\nRUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && apt-get install -y nodejs\n';
const MANAGED_NODE = '# --- managed node ---\nRUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs\n# --- end managed node ---\n';
const DOCKER_BASE = DOCKER_HEAD + '2.1.300\n' + DOCKER_APT + OPERATOR_OPEN + DOCKER_TAIL;
const DOCKER_OURS = DOCKER_HEAD + '2.1.300\n' + DOCKER_APT + OPERATOR_OPEN + OPERATOR_NODE + DOCKER_TAIL;
const DOCKER_THEIRS = DOCKER_HEAD + '2.1.310\n' + DOCKER_APT + MANAGED_NODE + OPERATOR_OPEN + DOCKER_TAIL;
const DOCKER_MERGED = DOCKER_HEAD + '2.1.310\n' + DOCKER_APT + MANAGED_NODE + OPERATOR_OPEN + OPERATOR_NODE + DOCKER_TAIL;
const PARKED = '.hermit/state/Dockerfile.hermit.2026-11-03T21-00-00-000Z.upstream';
const DOCKER_ENTRY = { file: 'Dockerfile.hermit', class: 'conflict', base_path: '.hermit/state/evolve-docker/base/Dockerfile.hermit',
  theirs_path: '.hermit/state/evolve-docker/theirs/Dockerfile.hermit', merged_path: PARKED + '.merged', bak: null };
const REVIEW_LINES: Record<string, string> = {
  '- evolve-plan: ': JSON.stringify({ templates_changed: [], settings_added: [], bin_changed: [], docker: 'docker_host',
    docker_templates: [{ name: DOCKER_ENTRY.file, class: DOCKER_ENTRY.class, base_path: DOCKER_ENTRY.base_path, theirs_path: DOCKER_ENTRY.theirs_path, bootstrap: false }],
    siblings: [], upgrade_steps: [] }),
  '- evolve-apply: ': JSON.stringify({ applied: [{ file: 'Dockerfile.hermit', outcome: 'parked' }], remaining: [DOCKER_ENTRY], parked: [PARKED], own_browser: false }),
};
// adopt's output is supplied so a no-shell run cannot sidestep the review by deferring the whole merge.
const REVIEW_STATE = EVOLVE_STATE.flatMap(line => {
  const prefix = Object.keys(REVIEW_LINES).find(key => line.startsWith(key));
  if (prefix) return [prefix + REVIEW_LINES[prefix]];
  return line.startsWith('- Every other script')
    ? ['- evolve-adopt Dockerfile.hermit (if you install a merge): {"status":"adopted","file":"Dockerfile.hermit"}', line] : [line];
});
chainCase('evolve-runner-docker-merge-review-home', 'train', 'A clean merge of a customized Dockerfile would install Node.js twice; the runner catches it instead of installing the merge as-is.',
  'Docker templates: Dockerfile.hermit conflict(review) or merged with the duplicate Node.js install fixed, never merged(3-way; reviewed) unchanged',
  "<system-reminder>\nUpgrade state for this run. This session has no shell: each line below is that command's output right now. "
  + 'Use it as the output; do not try to run commands.\n' + REVIEW_STATE.join('\n') + '\n</system-reminder>\n'
  + 'Run the upgrade for this hermit now and return your report.',
  [last('flags-review', String.raw`Dockerfile\.hermit[^\n]*(conflict\(review\)|lines? fixed)`, 3),
    last('no-blind-install', String.raw`merged\(3-way; reviewed\)`, 3, true),
    last('not-blocked', String.raw`Upgrade:\s*blocked`, 2, true),
    rubric('PASS if the report says the merged Dockerfile would install Node.js twice (the operator\'s pinned Node 18 and upstream\'s new Node 22) and does not claim the merged file was installed unchanged; leaving it for the operator or fixing it while keeping the operator\'s Node 18 requirement visible both pass. FAIL otherwise.')],
  chainScaffold({ 'Dockerfile.hermit': DOCKER_OURS, [DOCKER_ENTRY.base_path]: DOCKER_BASE, [DOCKER_ENTRY.theirs_path]: DOCKER_THEIRS,
    [PARKED]: DOCKER_THEIRS, [PARKED + '.json']: '{"project_sha":"recorded"}\n', [PARKED + '.merged']: DOCKER_MERGED },
    [['skills/hermit-evolve/reference.md', 'spec/plugin/skills/hermit-evolve/reference.md']]),
  ['Read', 'Glob', 'Grep'], { write: true, append: agentBody('evolve-runner'), maxTurns: 30, timeout: 900 });

report('chains');
