// Channel-responder reply-rule contract test.
// (bun test port of test-channel-responder-reply-rule.sh)
//
// Asserts that the §0 reply-via-channel contract is present in the
// channel-responder skill, that the hook is registered in hooks.json, and
// that the hook script exists. Prevents silent regressions on future
// SKILL.md rewrites or hooks.json edits.
//
// Usage: bun test tests/channel-responder-reply-rule.test.ts   (from the plugin root)

import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

const SKILL_PATH = path.join(PLUGIN_ROOT, 'skills', 'channel-responder', 'SKILL.md');
const HOOKS_PATH = path.join(PLUGIN_ROOT, 'hooks', 'hooks.json');
// The reminder is now a stage of scripts/user-prompt-pipeline.ts, not a
// separately-registered hook script — the file moved, the registration is the
// pipeline's. Test names below still say "channel-reply-reminder" because the
// guarantee they pin is unchanged.
const SCRIPT_PATH = path.join(PLUGIN_ROOT, 'scripts', 'lib', 'prompt-stages', 'channel-reply-reminder.ts');

const skill = fs.readFileSync(SKILL_PATH, 'utf-8');
const approvals = fs.readFileSync(path.join(path.dirname(SKILL_PATH), 'approvals.md'), 'utf-8');
const reference = fs.readFileSync(path.join(path.dirname(SKILL_PATH), 'reference.md'), 'utf-8');

// ~/.agents/probe-results/cc-skill-truncation-after-compaction-and-reinvoke.md
// records a 20,000-character rendered retention limit; leave room for growth.
// The Commands block costs ~700 rendered chars.
for (const name of ['channel-responder', 'task', 'proposal-act']) {
  test(`${name} fits the rendered retention budget`, () => {
    const text = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', name, 'SKILL.md'), 'utf-8');
    const rendered = text.replaceAll('${CLAUDE_PLUGIN_ROOT}', '/' + 'p'.repeat(99));
    expect(rendered.length).toBeLessThanOrEqual(18_500);
  });
}

test('responder sibling procedure references exist', () => {
  const siblings = [...skill.matchAll(/`([a-z][a-z0-9-]*\.md)`/g)].map(match => match[1]);
  expect(siblings).toContain('reference.md');
  for (const sibling of siblings) {
    expect(fs.existsSync(path.join(path.dirname(SKILL_PATH), sibling))).toBe(true);
  }
});

test('skill file exists', () => {
  expect(fs.existsSync(SKILL_PATH)).toBe(true);
});

test('skill has §0 heading', () => {
  expect(skill).toContain('## 0.');
});

test('skill §0 names reply via channel', () => {
  expect(skill).toContain('Reply via the channel');
});

test('skill §0 names generic reply tool pattern', () => {
  expect(skill).toContain('mcp__plugin_');
});

test('hooks.json has channel-reply-reminder entry', () => {
  expect(fs.readFileSync(HOOKS_PATH, 'utf-8')).toContain('user-prompt-pipeline.ts');
});

test('channel-reply-reminder.ts exists and is non-empty', () => {
  expect(fs.existsSync(SCRIPT_PATH)).toBe(true);
  expect(fs.statSync(SCRIPT_PATH).size).toBeGreaterThan(0);
});

// PROP-017: channel-safe approvals — resolver extension + bridge section.
test('resolver accepts numbered and label replies', () => {
  expect(approvals).toContain('match [<MP-id>] --reply');
  expect(approvals).toContain('MATCH|<id>|<yes|no|label>|<tier>|<on_resolve or ->');
  expect(approvals).toContain('AMBIGUOUS|<reason>');
});

test('channel-safe ask bridge section present', () => {
  expect(skill).toContain('Channel-safe ask bridge');
});

test('on_resolve resolution path present', () => {
  expect(approvals).toContain('on_resolve');
  expect(approvals).toContain('"action":"answered"');
});

// default_chat_id pin: chat-id persistence is hook-owned. §1e used to hand the
// model a config.json write recipe, which bypassed the hook's transcript-verified
// inbound gate and its maintainer-chat exclusion. A future SKILL.md rewrite must
// not reintroduce it.
test('§1e delegates chat-id persistence to the hook — no model-side write recipe', () => {
  expect(skill).toContain('hook-owned');
  expect(skill).toMatch(/never edit either field by hand/i);
  expect(skill).not.toMatch(/store the inbound `chat_id`/i);
});

test('§1e names the pinned proactive home', () => {
  expect(skill).toContain('default_chat_id');
});

// The pin is what keeps unattended sends (and no-allowlist control authority)
// from following whoever wrote last. Moving it is an asked write: the native
// permission prompt, not a terminal-only fence.
test('hermit-settings describes the briefing chat as an asked write', () => {
  const settings = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills', 'hermit-settings', 'SKILL.md'), 'utf-8',
  );
  expect(settings).toContain('briefing_chat');
  expect(settings).toContain('default_chat_id');
  expect(settings).toContain('This write raises the native permission prompt');
});

test('§1 applies memory role hook lines', () => {
  const context = skill.slice(skill.indexOf('## 1. Load Context'), skill.indexOf('## 1c.'));
  expect(context).toContain('[role');
});

test('§2 supports standing role memory management', () => {
  const classification = skill.slice(skill.indexOf('## 2. Classify'), skill.indexOf('## 3.'));
  expect(classification).toContain('Standing role');
  expect(classification).toContain('remember');
  expect(classification).toContain('forget');
  expect(classification).toContain('what do you remember');
  expect(reference).toContain('MEMORY.md');
  const roleStart = classification.indexOf('- **Standing role**');
  const roleEnd = classification.indexOf('\n- **', roleStart + 1);
  expect(roleStart).toBeGreaterThan(-1);
  expect(roleEnd).toBeGreaterThan(roleStart);
  const inlineRole = classification.slice(roleStart, roleEnd);
  expect(inlineRole).toContain('hermit-wide only for a primary operator (§1c)');
  expect(inlineRole).toContain('cadence or time without an inbound-message condition');
  const role = reference.slice(reference.indexOf('## Standing role'), reference.indexOf('## Harness command details'));
  expect(role).not.toContain('HEARTBEAT.md');
  expect(role).toContain('Save a hermit-wide `[role]` only for a primary operator (§1c)');
  expect(role).toContain('To forget or update a hermit-wide role, require a primary operator (§1c)');
  expect(role).toContain("operator's rule and write nothing");
  expect(role).toContain('Saved for this channel only:');
  const authorization = skill.slice(skill.indexOf('## 1c.'), skill.indexOf('## 2.'));
  for (const term of ['Primary operator', 'operators', 'operator_profile', 'maintainer', 'default_chat_id']) {
    expect(authorization).toContain(term);
  }

  // The index-line tag is what §1 matches on, and the memory directory is what makes the write land.
  expect(role).toContain('[role <key>:<chat_id>]');
  expect(role).toContain('projects/<path-key>/memory/');
});

test('control verdicts and classification precedence survive retention', () => {
  for (const rule of ['[harness-command] … requested', 'no bookkeeping, no tool call and no reply',
    '[pause] Hermit paused by', 'Only the channel reply tool works', 'no bookkeeping or other tools',
    '[pause] Hermit resumed by', 'ordinary turn',
    'hook-classified commands, then a pending micro answer, then an annotated task thread, then general classification']) {
    expect(skill).toContain(rule);
  }
});

// Pin moved procedures at their owning file, independently of retention length.
test('procedure owners retain mandatory rules and command interfaces', () => {
  const task = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/task/SKILL.md'), 'utf8');
  const outbound = fs.readFileSync(path.join(path.dirname(SKILL_PATH), 'outbound.md'), 'utf8');
  const rules: [string, string[]][] = [
    [task, [
      'Send the short "On it" acknowledgement through the channel',
      'before reading task inputs or doing substantive work',
      'Use `/hermitd:task` for progress and result operations',
      'block .hermit <id> --result-stdin',
      'listing: "unconfirmed"', 'positive `result_rev`',
      'After a requested record change succeeds, acknowledge it through the channel',
      'Finished recommendations, drafts and reviews awaiting acceptance require `--result-stdin`',
      'If a finished outcome returns a stall digest, run the result form before ending the turn',
      'If delivery or recording fails, report what remains incomplete',
      'one open record owns a chat', 'steering, never a second record',
      "chat-lookup --chat-id '<chat_id>'", "thread-create --chat-id '<chat_id>' --message-id '<message_id>' --name '<title>'",
      'title of 1 to 100 characters', 'on `ERROR|`, report it and create no record',
      'Each gets its own record, thread, card and worker', 'end the turn only after the last dispatch',
      'Every other chat is its own thread',
      'That reply is the progress card', '--owner resident --conversation <key>',
      'Omit `--card` when the channel returned no message id; do not invent one',
      "Download the message's attachments first", 'in the background', 'attachment paths',
      '--owner worker:<agentId>', 'including after a resident `/clear`',
      'On success pipe the steer', 'Only when that send fails',
      "history --source '<source>' --chat-id '<chat_id>' --limit 100", "with the record's notes and that path",
      "ignore it when the completing agent's id is not that record's `owner`",
      'note .hermit <task-id> --owner resident', '[[helper-report <id>]]',
      '--result-stdin < .hermit/helper-reports/<id>.md',
      '--waiting-on <requester> --status-line ... --next ...',
      'owner=resident, waiting=true', '--clear-waiting',
      'Terminal assignments never go through here',
      "execute only the hook's `[conversation command: <name>]` annotation",
      'never invoke the harness command', 'command needs an open task thread, and starts nothing',
      'per-conversation `!model` and `!effort` are not supported', '--muted true|false',
      'Muting suppresses unmentioned steering', 'On a stop failure, report it and start nothing',
      'Return after the command', 'All conversation script arguments are shell-quoted values',
      "Parse each command's `OK|`/`ERROR|` result before moving on",
      'never interpolate it into executable code',
      "--open --owner 'worker:*' --json", "Do not disclose another chat's task text",
      'If compatible with current task: pipe the steering', 'confirm with the operator before switching',
      "the old card's id is never reused", '--reason-stdin',
      "Post a non-result stall digest's one status/next message to its requester",
      'state its queue position from the open-record order', 'continue with `next_queued` in the same turn',
      'Never silently abandon work in progress',
      '`TASKS.md` defines what counts as confirmation',
      'Close with a reason quoting the message that confirmed',
      'the reply names the close so the requester can object',
      'exits 0 only when the whole definition of done holds',
      'runs `task-check.ts <id>` in the same turn',
      'It only observes and never writes, deletes, sends or deploys',
      'A record with a named approver gets no check',
    ]],
    [approvals, [
      'match [<MP-id>] --reply', 'on `AMBIGUOUS`', 'Preserve micro-proposal precedence',
      'never hand-edit `state/micro-proposals.json`', 'resolve on disk FIRST, then invoke',
      'resolve <id> --action answered --answer "<selected label>"',
      'removes the pending entry, then appends', 'do not re-run the resolve call',
      'Insert a single-word verb **bare**', 'Keep double quotes around multi-word',
      'excluded from approval-rate metrics', 'execute the change at next idle',
      'record the outcome with `task.ts note` when a record is open',
      'resolve <id> --action approved', 'create PROP-NNN via `/hermitd:proposal-create`',
      'resolve <id> --action rejected', 'If no pending micro-proposals: classify as normal message',
      '`YES` / "go ahead" / "accept" → `accept`', '`LATER` / "hold" / "defer" → `defer`',
      '`NO` / "drop" / "dismiss" → `dismiss`', '`proposal-index` (Commands)',
      'Match an explicit `#N` or `PROP-NNN`', 'apply when exactly one exists',
      'Never surface internal proposal fields back to the channel',
    ]],
    [reference, [
      'current-chat pinned role without confirmation', 'Save a hermit-wide `[role]` only for a primary operator (§1c)',
      'Write one `type: feedback` auto-memory topic file and one `MEMORY.md` index line',
      'feedback_role_<key>_<chat_id>_<slug>.md', 'feedback_role_<slug>.md',
      "Rewrite an existing rule's file for restatements; do not duplicate it",
      "Preserve the operator's sentence", 'keeping the full text in the topic file',
      'Pinned roles apply only to that chat', 'hermit-wide roles apply to every turn',
      'full rule and provenance', 'Use `external-content` when the sender is not a primary operator',
      "Say 'forget the <short name> rule' to remove it", 'show the `[role` hook lines that apply to this chat',
      'Do not include routines', 'require a primary operator (§1c)',
      "operator's rule and write nothing", 'Delete or rewrite the authorized topic file and index line',
      'name candidates and await the answer', 'writes no `## Findings` line and no observations row',
      'Permission mode lasts for the current session', 'Replies report observed success, failure text, or an unknown outcome',
      'direct on Discord and Telegram and model-relayed elsewhere', 'settings-level deny or ask',
      'saves `model`, `effortLevel`, and `advisorModel` in user settings',
      '`!permission-mode` accepts `default`, `acceptEdits`, or `auto`',
      'Report the actual mode supplied in the next prompt, not the requested mode',
      '`!advisor off` clears it', 'do not invent a value list', 'The mod relays observed rejections to the requesting chat',
      "persists in Claude Code's user settings across restarts", 'Each advisor call adds spend',
      'the mod starts it as its own turn',
      'Never invoke bare `!advisor`',
      '**Do not write a finding**', 'with no open record, write nothing',
      '[HH:MM] Channel pattern:', '[origin: external]', 'Do not classify tier, tag Evidence Source',
      'instead of** a `## Findings` line',
      '`observations-observe` (Commands)', 'skill-correction --origin=<own-work|external-content>',
      'skill-correction:<canonical-name>', 'lowercase bare `name:` frontmatter',
      'Rejected rows return `ERROR|<reason>` at exit 0',
      'fix the call, never retry blindly or block the reply', 'At most one row per turn',
      'do not guess a `<name>` or ask for disambiguation mid-reply',
    ]],
    [outbound, [
      'Main owns sends and any `AskUserQuestion`; delegates return composed messages',
      'exclude the `primary` string pointer when iterating', 'Push is best-effort; do not retry on failure',
      'do not log a `channel-send-unavailable` issue for this branch', 'Respond in conversation either way',
      'do not resolve the channel yourself', 'hermitd-run channel-send .hermit --notice',
      'Any decision, reply or operator action requires a plain client version',
      'complete', 'richer version of the same notice', '"sensitive": true',
      'apply §0 Message formatting', '**Exit 0**', '**Exit 2**', 'Fix and re-run', '**Exit 1**',
      'PushNotification', 'deduped `channel-send-unavailable` issue',
      'enabled channel is unreachable', 'Never send a proactive notice through a channel reply tool',
      'never advise `/<channel>:access`', 'hermit-settings channels → edit <name> → group',
    ]],
  ];
  expect(skill).toContain('- `proposal-index`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts index .hermit`');
  for (const [text, required] of rules) for (const rule of required) expect(text).toContain(rule);
});
