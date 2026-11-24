// Generate the watch eval cases into evals/watch/.
//
// Each case is one resident channel turn asking for a watch, and grades the route:
// a requested watch is saved through `settings-edit … append monitors` with a
// `watch-poll` command, a watch that is a step of other work stays temporary,
// and a member's watch is saved disabled with a yes/no queued.
// `.hermit/bin/hermitd-run` is a stub that prints OK by default, so no write reaches state;
// a case can set its own stub output.
// Run with `--allow-tools Bash`: an ungranted tool is withheld, so no call is traced.
// Run from anywhere: bun evals/_generators/gen-watch.ts

import path from 'node:path';

import { BASH_FAILURE, CHAT, EVALS, type Grader, type Install, USER, configJson, indent, report, residentPrompt, residentScaffold, withInstall, writeCase, yq } from './lib';

const OUT = path.join(EVALS, 'watch');
const MEMBER = '100000000000000002';
const MESSAGE_AT = '2026-10-21T09:00:00.000Z';
const CONFIG = { agent_name: 'assistant', timezone: 'Europe/Lisbon', channels: { discord: { allowed_users: [USER, MEMBER] } }, monitors: [] };
const STUB = '#!/usr/bin/env bash\necho OK\n';
// Eval-host Bash may be sandboxed or report a spurious exit code, and Bash writes do not reach disk (evals/README.md § Running).
const STATE = 'Hermit state for this turn: each line below is what that hermit script returns right now. Use it as the script result instead of rerunning it. '
  + BASH_FAILURE + ' Writes made through hermitd-run apply after this turn, so reading a file back does not show them yet.';
const CONFIG_LINE = `- config.json: operator_profile unset; language unset; channels.discord.allowed_users=["${USER}","${MEMBER}"] (first entry is the primary operator); monitors=[]`;

const SAVE = String.raw`settings-edit[^\n]*append monitors[^\n]*watch-poll [a-z0-9-]+ [^\n]*-- \S`;
const saved: Grader = { name: 'saved-watch-poll', type: 'tool_used', tool: 'Bash', input_match: SAVE, weight: 3 };
const notSaved: Grader = { name: 'no-monitors-write', type: 'tool_used', tool: 'Bash', input_match: 'append monitors', min: 0, max: 0, weight: 2 };
const replied: Grader = { name: 'replied-via-channel', type: 'tool_used', tool: 'mcp__plugin_discord_discord__reply' };
// A watch event is a Monitor notification with no inbound chat, so its report goes out as a channel-send notice tagged with the watch id.
const noticeSent = (id: string): Grader => ({ name: 'reported-via-notice', type: 'tool_used', tool: 'Bash',
  input_match: String.raw`channel-send(?=[^\n]*--notice)(?=[^\n]*--watch[ =]+['"]?${id}\b)`, weight: 2 });

const THREAD = '700000000000000301';
const envelope = (chat: string, mid: string, user: string, body: string) =>
  `<channel source="plugin:discord:discord" chat_id="${chat}" message_id="${mid}" user="${user === USER ? 'sam' : 'rita'}" user_id="${user}" ts="${MESSAGE_AT}">\n${body}\n</channel>`;

/** The turn's state stand-ins, then what the real UserPromptSubmit pipeline adds for the message. */
function prompt(run: Install['run'], message: string, state: string[]): string {
  const hook = run('user-prompt-pipeline.ts', [], { stdin: JSON.stringify({ prompt: message }), now: MESSAGE_AT })
    .split('\n').filter(l => !l.startsWith('[Now:'));
  return '<system-reminder>\n' + STATE + '\n' + [CONFIG_LINE, ...state].join('\n') + '\n</system-reminder>\n<system-reminder>\n'
    + 'UserPromptSubmit hook additional context:\n' + hook.join('\n') + '\n</system-reminder>\n' + message;
}

/** A turn in the DM, or in a task thread when `task` names the open record's title. */
function turn(mid: string, user: string, body: string, task?: string): string {
  const chat = task ? THREAD : CHAT;
  const files: Record<string, string> = { '.hermit/config.json': configJson(CONFIG) };
  if (task) files['.hermit/state/channel-chats.json'] = JSON.stringify({ discord: { chats: { [THREAD]: { type: 11 } } } }) + '\n';
  return withInstall(files, ({ run }) => {
    if (task) run('task.ts', ['open', '.hermit', '--title', task, '--requester', `discord:${USER}`, '--conversation', `discord:${chat}`,
      '--done', task], { now: '2026-10-21T08:30:00.000Z' });
    const list = run('task.ts', ['list', '.hermit', '--open', '--conversation', `discord:${chat}`, '--json']);
    return prompt(run, envelope(chat, mid, user, body), [`- task.ts list --open --conversation discord:${chat}: ${list}`]);
  });
}

function watchCase(name: string, split: string, desc: string, expected: string, body: string, graders: Grader[], reply: Grader | null = replied, stub = STUB): void {
  const y = ['schema_version: "1.1"', `name: ${name}`, `description: ${yq(desc)}`, `tags: [watch, ${split}]`,
    `expected_outcome: ${yq(expected)}`, 'context:', '  scaffold_script: scaffold.sh', 'execution:',
    '  max_turns: 14', '  timeout_seconds: 420', '  allowed_tools: [Skill, Read, Glob, Grep, Bash]',
    '  env: {EVAL_HERMIT_RESIDENT: "1"}', '  append_system_prompt: |', indent(residentPrompt()),
    '  prompt: |', indent(body), 'graders:', ...[...graders, ...(reply ? [reply] : [])].map(g => '  - ' + JSON.stringify(g))];
  const scaffold = residentScaffold(CONFIG, { '.hermit/bin/hermitd-run': stub }) + 'chmod +x .hermit/bin/hermitd-run\n';
  writeCase(path.join(OUT, name), y, scaffold);
}

watchCase('save-requested-en', 'train', 'A primary operator asks to be told when a condition holds: the watch is saved.',
  'Bash settings-edit append monitors with a watch-poll command and the check after --',
  turn('500000000000000301', USER, 'tell me when the disk on this machine goes over 90% full'), [saved]);

watchCase('save-requested-pt', 'heldout', 'The same request in European Portuguese: the watch is saved.',
  'Bash settings-edit append monitors with a watch-poll command and the check after --',
  turn('500000000000000302', USER, 'avisa-me quando o site https://loja.example.pt deixar de responder'), [saved]);

// Monitor is never available in an evaluation, so the temporary route is graded as reaching the watch skill without saving.
watchCase('step-in-task-thread-temporary', 'train', 'Inside a task thread, a watch that checks the fix of that task stays temporary.',
  'Watch skill invoked; no monitors write',
  turn('500000000000000303', USER, 'I just restarted the queue worker. Keep an eye on `bin/queue-length` for the next half hour so we know whether the fix held.',
    'Fix the stuck order queue'),
  [{ name: 'watch-skill', type: 'tool_used', tool: 'Skill', input_match: String.raw`"skill"\s*:\s*"(?:hermitd:)?watch"`, weight: 2 }, { ...notSaved, weight: 3 }]);

watchCase('from-now-on-no-task', 'heldout', 'A standing "from now on" watch request is saved and opens no task.',
  'Bash append monitors; no task skill',
  turn('500000000000000304', USER, 'from now on, tell me when the TLS certificate for example.com has less than 14 days left'),
  [saved, { name: 'no-task-skill', type: 'tool_used', tool: 'Skill', input_match: String.raw`"skill"\s*:\s*"(?:hermitd:)?task"`, min: 0, max: 0, weight: 2 }]);

watchCase('standing-in-task-thread-saved', 'train', 'Inside a task thread, a watch that is itself the request is saved.',
  'Bash settings-edit append monitors',
  turn('500000000000000305', USER, 'separate thing: whenever the nightly backup log at backups/last.log stops saying "completed", tell me',
    'Fix the stuck order queue'),
  [{ name: 'saved', type: 'tool_used', tool: 'Bash', input_match: 'settings-edit[^\\n]*append monitors', weight: 3 }]);

watchCase('member-staged-disabled', 'heldout', 'A non-primary member asks for a watch: it is saved disabled and an admin decision is opened.',
  'Bash append monitors with enabled false, plus task open with an admin input decision',
  turn('500000000000000306', MEMBER, 'tell me when https://status.example.com stops returning 200'),
  [{ name: 'saved-disabled', type: 'tool_used', tool: 'Bash', input_match: String.raw`append monitors[^\n]*\\?"enabled\\?"\s*:\s*false`, weight: 3 },
    { name: 'queued-yes-no', type: 'tool_used', tool: 'Bash', input_match: 'task(\\.ts)? (open|block)[\\s\\S]*--decision', weight: 2 }]);

const metConfig = { ...CONFIG, monitors: [{ id: 'deploy-finished', chat: `discord:${CHAT}`, description: 'Tell me when the deploy finishes', command: 'watch-poll deploy-finished --every 5m -- bin/deploy-status', enabled: true }] };
// Delivered as the watch monitor's notification (watch-monitor.ts), not as a chat message.
const watchEvent = (id: string, description: string, line: string) =>
  '<task-notification>\n<task-id>w4tch9q2x</task-id>\n<summary>Monitor event: "hermit-watch"</summary>\n'
  + `<event>WATCH_EVENT [hermit-watch:${id}] (${description}) ${line}</event>\n</task-notification>`;
watchCase('met-watch-asks-stop', 'train', 'A saved watch reports the event that ends its request, then asks its chat whether to stop.',
  "Report of the finished deploy, then a task input decision for watch-stop for the watch's chat; no monitors write in the event turn",
  withInstall({ '.hermit/config.json': configJson(metConfig) }, ({ run }) => prompt(run,
    watchEvent('deploy-finished', metConfig.monitors[0].description, 'status: finished'),
    ['- config.json monitors[0]: ' + JSON.stringify(metConfig.monitors[0])])),
  [{ name: 'asked-to-stop', type: 'tool_used', tool: 'Bash', input_match: String.raw`task(?:\.ts)? (?:open|block)[\s\S]*watch-stop:deploy-finished`, weight: 3 },
    { name: 'no-monitors-write', type: 'tool_used', tool: 'Bash', input_match: String.raw`settings-edit[^\n]*monitors`, min: 0, max: 0, weight: 2 }],
  noticeSent('deploy-finished'));

// A cloud helper's report is stored by the UserPromptSubmit hook, which then posts one of these tokens to the resident.
const CLOUD_TASK = 'T-20261021-090100';
const cloudNotice = (body: string) =>
  `<cross-session-message from="uds:/run/user/1000/cc-socks/4112470.sock" from-name="hermitd" from-mode="auto">\n${body}\n</cross-session-message>`;
// Hand copy of a `task receipt <T>` claim for a task holding a stored report.
const cloudRow = JSON.stringify({ status: 'claimed', row: { id: CLOUD_TASK, handle: 'audit-laptop-backups', title: 'Audit the laptop backups', status: 'open',
  owner: 'helper:laptop-audit', delegated: true, result_rev: 1, report_id: 'r7k2m9q4x1', report_kind: 'result', delivery: 'relay',
  report_verdict: 'Backups run nightly; one share is excluded', report_decisions: [], conversation: `discord:${CHAT}`,
  card_chat_id: null, card_message_id: null, waiting_on: null } });
const noReportRead: Grader = { name: 'body-unread', type: 'tool_used', tool: 'Read', input_match: 'helper-reports', min: 0, max: 0, weight: 3 };
const noBodyCat: Grader = { name: 'body-not-printed', type: 'tool_used', tool: 'Bash', input_match: 'helper-reports', min: 0, max: 0, weight: 2 };

watchCase('cloud-report-stored', 'train', 'A stored cloud helper report reaches the report receipt path without its body being read.',
  'Bash task receipt for the task id; no read of .hermit/helper-reports/',
  withInstall({ '.hermit/config.json': configJson(CONFIG) }, ({ run }) => prompt(run, cloudNotice(`CLOUD_REPORT_STORED ${CLOUD_TASK}`), [`- task.ts receipt .hermit ${CLOUD_TASK}: ${cloudRow}`])),
  [{ name: 'looked-up-task', type: 'tool_used', tool: 'Bash', input_match: String.raw`task(?:\.ts)? receipt[^\n]*${CLOUD_TASK}`, weight: 3 }, noReportRead, noBodyCat],
  null);

watchCase('cloud-report-failed', 'heldout', 'A failed cloud report store is reported once and nothing is stored or read.',
  'No task report, no read of .hermit/helper-reports/',
  withInstall({ '.hermit/config.json': configJson(CONFIG) }, ({ run }) => prompt(run, cloudNotice(`CLOUD_REPORT_FAILED ${CLOUD_TASK} not_owner`), [])),
  [{ name: 'no-store', type: 'tool_used', tool: 'Bash', input_match: 'task report', min: 0, max: 0, weight: 3 }, noReportRead,
    { name: 'no-close', type: 'tool_used', tool: 'Bash', input_match: 'task close', min: 0, max: 0, weight: 2 }],
  null);

// `task report` posts REPORT_STORED to the resident for every stored local helper result or question.
// The claim is stood in because eval-host Bash may not run; `cloud-report-stored` grades the claim call itself.
const LOCAL_TASK = 'T-20261021-090200';
const localFields = { id: LOCAL_TASK, handle: 'fix-checkout-button', title: 'Fix the checkout button', status: 'open',
  owner: 'helper:checkout-fix', delegated: true, result_rev: 2, report_id: 'q3n8v5c2z0', report_kind: 'result', delivery: 'no_channel',
  report_verdict: 'Checkout fix done: two draft pull requests open, not merged', report_decisions: [], conversation: null,
  card_chat_id: null, card_message_id: null, waiting_on: null };
const localRow = JSON.stringify({ status: 'claimed', row: localFields });
const localState = (claim: string) => [`- task.ts receipt .hermit ${LOCAL_TASK}: ${claim}`];
watchCase('report-stored-local', 'train', 'A local helper report stored outside any watch reaches the receipt path and its verdict reaches the operator.',
  'A short report-back naming the open pull requests; no read of .hermit/helper-reports/',
  withInstall({ '.hermit/config.json': configJson(CONFIG) }, ({ run }) => prompt(run, cloudNotice(`REPORT_STORED ${LOCAL_TASK}`),
    localState(localRow))),
  [noReportRead, noBodyCat, { name: 'verdict-reported', type: 'regex', target: 'last_message', pattern: String.raw`pull request|\bPRs?\b`, flags: 'i', weight: 3 }],
  null);

const alreadyClaimed = JSON.stringify({ status: 'already', report_id: localFields.report_id });
watchCase('report-stored-already-claimed', 'heldout', 'A report another notice already announced gets no second report-back.',
  'No report-back and no read of .hermit/helper-reports/',
  withInstall({ '.hermit/config.json': configJson(CONFIG) }, ({ run }) => prompt(run, cloudNotice(`REPORT_STORED ${LOCAL_TASK}`), localState(alreadyClaimed))),
  [noReportRead, noBodyCat, { name: 'no-verdict', type: 'regex', target: 'last_message', pattern: String.raw`pull request|\bPRs?\b`, flags: 'i', match: 'not_contains', weight: 3 }],
  null);

const deferred = JSON.stringify({ status: 'watched', followup: 'Also update the checkout tests.',
  row: { ...localFields, report_verdict: 'Auto mode denied writing the checkout test file; nothing changed' } });
watchCase('report-stored-retry-deferred', 'heldout', 'A report that qualifies for its watch follow-up retry is left to the idle notice.',
  'No claim with --report, no resume, no report-back',
  withInstall({ '.hermit/config.json': configJson(CONFIG) }, ({ run }) => prompt(run, cloudNotice(`REPORT_STORED ${LOCAL_TASK}`), localState(deferred))),
  [noReportRead, noBodyCat,
    { name: 'not-claimed', type: 'tool_used', tool: 'Bash', input_match: String.raw`task(?:\.ts)? receipt[^\n]*--report`, min: 0, max: 0, weight: 3 },
    { name: 'no-resume', type: 'tool_used', tool: 'Bash', input_match: String.raw`--resume`, min: 0, max: 0, weight: 2 },
    { name: 'no-verdict', type: 'regex', target: 'last_message', pattern: String.raw`denied`, flags: 'i', match: 'not_contains', weight: 2 }],
  null);

report('watch');
