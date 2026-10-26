// Generate the proposal-triage eval cases into evals/proposal-triage/.
// Run from anywhere: bun evals/_generators/gen-triage.ts

import path from 'node:path';

import { EVALS, type Grader, configJson, graderYaml, heredocs, indent, report, writeCase, yq } from './lib';

type Entry = Record<string, unknown>;
type Prop = [fname: string, body: string, entry: Entry];
export interface Universe { proposals: Prop[]; operator: string; memory: Record<string, string>; compiled: Record<string, string> }

function prop(pid: string, slug: string, status: string, title: string, problem: string, created = '2026-08-14T10:00:00+01:00', tags: string[] = []): Prop {
  const fname = `${pid}-${slug}-100000.md`;
  const body = `---\nid: ${pid}-${slug}-100000\ntitle: "${title}"\nstatus: ${status}\nsource: auto-detected\ncreated: ${created}\n`
    + `category: improvement\ntags: ${JSON.stringify(tags)}\n---\n# Proposal: ${pid} — ${title}\n\n## Problem\n${problem}\n\n`
    + '## Proposed Solution\nSee title.\n';
  const entry = { id: `${pid}-${slug}-100000`, file: fname, status, source: 'auto-detected', category: 'improvement', title, created, tags };
  return [fname, body, entry];
}

export const HOME: Universe = {
  proposals: [
    prop('PROP-004', 'washer-finished-notice', 'resolved', 'Notify when the washing machine finishes',
      'Laundry sat wet for hours because nobody knew the cycle had ended.'),
    prop('PROP-009', 'irrigation-rain-skip', 'proposed', 'Skip garden irrigation when rain is forecast',
      'The sprinklers run on schedule even on days with heavy rain, wasting water.'),
    prop('PROP-011', 'daily-energy-report', 'dismissed', 'Daily energy usage report in the morning brief',
      'No daily view of electricity use.'),
    prop('PROP-013', 'notices-in-portuguese', 'deferred', 'Send household notices in Portuguese',
      'Half the household reads Portuguese more comfortably than English.'),
    prop('PROP-015', 'auto-lock-midnight', 'accepted', 'Auto-lock the front door at midnight',
      'The front door was found unlocked in the morning several times.'),
  ],
  operator: "# Operator\n\nHousehold of two adults and a cat. Prefers short messages.\n\n## Preferences\n- Don't add more daily or weekly reports; the morning brief is enough.\n- Never unlock doors automatically.\n",
  memory: {
    'feedback_no_camera_automations.md': "---\nname: no-camera-automations\ndescription: Do not propose automations that use the indoor cameras\ntype: feedback\n---\n\nDon't propose automations driven by the indoor cameras.\n**Why:** privacy; the cameras are for when the house is empty.\n**How to apply:** treat camera-based ideas as already decided against.\n",
    'feedback_fewer_phone_notifications.md': "---\nname: fewer-phone-notifications\ndescription: No new phone notifications for routine household events\ntype: feedback\n---\n\nDon't add new phone notifications for routine household events.\n**Why:** notification fatigue.\n**How to apply:** prefer the morning brief over a push.\n",
    'reference_irrigation_entities.md': '---\nname: irrigation-entities\ndescription: Entity names for the garden irrigation valves and the rain sensor\ntype: reference\n---\n\nValves: valve.garden_front, valve.garden_back_zone2, switch.drip_line. Rain sensor: binary_sensor.rain_gauge.\n',
    'user_household.md': '---\nname: household\ndescription: Who lives in the house\ntype: user\n---\n\nTwo adults and a cat.\n',
  },
  compiled: { 'topic-energy-baseline.md': '---\ntitle: Energy usage baseline\ntype: topic\ncreated: 2026-09-01T09:00:00+01:00\ntags: [energy]\n---\n\nAverage daily use 9.4 kWh.\n' },
};

export const SHOP: Universe = {
  proposals: [
    prop('PROP-021', 'unpaid-invoice-reminders', 'proposed', 'Remind customers about invoices unpaid after 7 days',
      'Wholesale invoices go unpaid for weeks because nobody chases them.'),
    prop('PROP-024', 'weekly-sales-summary', 'dismissed', 'Weekly sales summary to the channel',
      'No weekly overview of sales.'),
    prop('PROP-026', 'nightly-db-backup', 'resolved', 'Back up the shop database nightly',
      'The order database had no backup.'),
    prop('PROP-028', 'low-stock-reorder', 'accepted', 'Reorder alert when stock falls below 5 units',
      'Popular teas sold out before anyone noticed.'),
  ],
  operator: '# Operator\n\nRuns a small online tea shop alone.\n\n## Preferences\n- I decided not to send automated messages to customers without my review.\n- Keep answers short.\n',
  memory: {
    'feedback_no_social_posting.md': "---\nname: no-social-posting\ndescription: Do not propose posting to social media on my behalf\ntype: feedback\n---\n\nDon't propose posting to social media for me.\n**Why:** I want my own voice there.\n**How to apply:** suppress social-posting ideas.\n",
    'project_q4_priorities.md': '---\nname: q4-priorities\ndescription: Q4 focus is wholesale orders; the website redesign is postponed to next year\nmetadata:\n  type: project\n---\n\nQ4 2026: focus on wholesale orders. The website and homepage redesign is postponed until 2027.\n**Why:** cash flow.\n**How to apply:** no redesign work this quarter.\n',
  },
  compiled: { 'topic-wholesale-pipeline.md': '---\ntitle: Wholesale pipeline\ntype: topic\ncreated: 2026-09-10T09:00:00+01:00\ntags: [wholesale]\n---\n\nFour cafes ordering monthly.\n' },
};

/** scaffold.sh seeding a hermit state dir (config, proposals, index, OPERATOR.md, compiled/) and a memory/ dir. */
export function scaffold(universe: Universe, withConfig = true): string {
  const files: Record<string, string> = {};
  const root = '.hermit';
  if (withConfig) files[`${root}/config.json`] = configJson({ agent_name: 'assistant', timezone: 'Europe/Lisbon' });
  const entries: Entry[] = [];
  for (const [fname, body, entry] of universe.proposals) {
    files[`${root}/proposals/${fname}`] = body;
    entries.push(entry);
  }
  files[`${root}/state/proposals-index.json`] = JSON.stringify({ updated: '2026-10-01T08:00:00Z', count: entries.length, proposals: entries }, null, 2) + '\n';
  files[`${root}/OPERATOR.md`] = universe.operator;
  const field = (body: string, key: string) => body.split('\n').find(l => l.startsWith(`${key}:`))!.split(/:(.*)/s)[1].trim();
  const idx: string[] = [];
  for (const [fname, body] of Object.entries(universe.memory)) {
    files[`memory/${fname}`] = body;
    idx.push(`- [${field(body, 'name')}](${fname}) — ${field(body, 'description')}`);
  }
  files['memory/MEMORY.md'] = idx.join('\n') + '\n';
  for (const [fname, body] of Object.entries(universe.compiled)) files[`${root}/compiled/${fname}`] = body;
  const sh = ['#!/usr/bin/env bash', '# Seeds a hermit state dir and auto-memory for this case (runs only with --scaffold).', 'set -e', ...heredocs(files)];
  return sh.join('\n') + '\n';
}

/** The anchor line a caller resolves: {ROOT} and {MEM} become the absolute `.hermit` and `memory` paths. */
export const ANCHOR = 'Anchor: root={ROOT} memory_dir={MEM}\n';

const CALLER = "You are running proposal-create's triage step for this hermit. Dispatch the `hermitd:proposal-triage` agent with the "
  + 'input below. Replace {ROOT} with the absolute path of `.hermit` in your current working directory and {MEM} with the '
  + 'absolute path of the `memory` directory beside it (also directly in your working directory); change nothing else. '
  + "Then reply with the agent's output verbatim, with nothing added.\n\n<input>\n";

export function candidate(title: string, evidence: string, source?: string, origin?: string, artifact?: string): string {
  const lines = [`Title: ${title}`];
  if (source) lines.push(`Evidence Source: ${source}`);
  if (origin) lines.push(`Evidence Origin: ${origin}`);
  lines.push(`Evidence: ${evidence}`);
  if (artifact) lines.push(`Artifact: ${artifact}`);
  return lines.join('\n');
}

function verdict(kind: string, rest = '', w = 3, name?: string): Grader {
  return { name: name ?? `verdict-${kind.toLowerCase()}`, type: 'regex', target: 'last_message', pattern: String.raw`(^|\n)\s*` + kind + ': ' + rest, weight: w };
}

function meta(key: string, val: string, w = 1): Grader {
  return { name: `meta-${key}`, type: 'regex', target: 'last_message', pattern: String.raw`(^|\n)\s*` + key + ': ' + val, weight: w };
}

const notContains = (name: string, pattern: string, w = 2): Grader => ({ name, type: 'regex', target: 'last_message', pattern, match: 'not_contains', weight: w });

const COMMON: Grader[] = [
  { name: 'dispatched-triage', type: 'tool_used', tool: 'Agent', input_match: 'proposal-triage' },
  { name: 'verdict-first', type: 'regex', target: 'last_message', pattern: String.raw`^\s*` + '`*' + String.raw`\s*(CREATE|SUPPRESS|DUPLICATE|GATE_BLIND): ` },
];

function triageCase(name: string, tag: string, desc: string, expected: string, universe: Universe, cands: string[], graders: Grader[], withConfig = true): void {
  const prompt = CALLER + ANCHOR + cands.join('\n\n') + '\n</input>';
  const y = ['schema_version: "1.1"', `name: ${name}`, `description: ${yq(desc)}`, `tags: [proposal-triage, ${tag}]`,
    `expected_outcome: ${yq(expected)}`, 'context:', '  scaffold_script: scaffold.sh', 'execution:', '  max_turns: 8',
    '  timeout_seconds: 400', '  allowed_tools: [Agent, Read, Glob, Grep]', '  prompt: |', indent(prompt), 'graders:',
    ...[...COMMON, ...graders].map(graderYaml)];
  writeCase(path.join(EVALS, 'proposal-triage', name), y, scaffold(universe, withConfig));
}

if (import.meta.main) {
  triageCase('dup-proposed-home', 'train', 'Same problem as an open proposed proposal: DUPLICATE.', 'DUPLICATE: … — PROP-009', HOME,
    [candidate('Skip watering the garden on rainy days', 'The irrigation ran on 4 of the last 6 rainy days (rain gauge above 5 mm), soaking the lawn and wasting water.', 'scheduled-check/irrigation')],
    [verdict('DUPLICATE', String.raw`[^\n]*PROP-009`)]);

  triageCase('dup-dismissed-shop', 'heldout', 'Same problem as a dismissed proposal: DUPLICATE, not a fresh CREATE.', 'DUPLICATE: … — PROP-024', SHOP,
    [candidate('Send me a weekly summary of sales', 'Sales questions came up in three conversations this month; a weekly sales summary posted to the channel would answer them.', 'capability-brainstorm')],
    [verdict('DUPLICATE', String.raw`[^\n]*PROP-024`)]);

  triageCase('dup-deferred-home', 'heldout', 'Same problem as a deferred proposal: DUPLICATE.', 'DUPLICATE: … — PROP-013', HOME,
    [candidate('Write household alerts in Portuguese', 'Two household members asked for alerts in Portuguese; English notices were misread twice.', 'operator-request')],
    [verdict('DUPLICATE', String.raw`[^\n]*PROP-013`)]);

  triageCase('resolved-recurs-home', 'train', 'Same problem as a resolved proposal that came back: not DUPLICATE; CREATE with closest_prop.',
    'CREATE plus closest_prop: PROP-004', HOME,
    [candidate('Washer-finished notices stopped arriving', 'Since the washer firmware update, the finished notice failed on 3 of the last 5 loads and laundry stayed wet overnight twice. Re-pointing the automation to the new power-sensor entity fixes it.', 'current-session')],
    [verdict('CREATE'), meta('closest_prop', 'PROP-004', 2), notContains('not-duplicate', String.raw`(^|\n)\s*DUPLICATE:`)]);

  triageCase('shared-surface-shop', 'heldout', 'Shares the invoice surface with a proposed proposal but solves a different problem: CREATE.',
    'CREATE (not DUPLICATE of PROP-021)', SHOP,
    [candidate('Alert me when a customer card payment fails', 'The payment provider declined 6 card payments in September and I learned about each only when the customer emailed, days later; two orders were lost. A same-day alert from the provider webhook would let me follow up.', 'scheduled-check/payments')],
    [verdict('CREATE'), notContains('not-duplicate', String.raw`(^|\n)\s*DUPLICATE:`)]);

  triageCase('memory-feedback-home', 'train', 'Operator feedback memory already rules the idea out: SUPPRESS covered-by-memory with memory_ref.',
    'SUPPRESS … covered-by-memory, memory_ref: feedback_no_camera_automations.md', HOME,
    [candidate("Use the living-room camera to tell when the cat's bowl is empty", "The cat's bowl was found empty at dinner twice this week; the living-room camera can see the bowl.", 'capability-brainstorm')],
    [verdict('SUPPRESS', String.raw`[^\n]*covered-by-memory`), meta('memory_ref', String.raw`feedback_no_camera_automations\.md`, 2)]);

  triageCase('memory-project-nested-shop', 'heldout', 'A project memory whose type sits under metadata covers the idea: SUPPRESS covered-by-memory.',
    'SUPPRESS … covered-by-memory, memory_ref: project_q4_priorities.md', SHOP,
    [candidate('Redesign the shop homepage this quarter', 'The homepage still shows the summer collection and the bounce rate rose from 41% to 55% over two months.', 'capability-brainstorm')],
    [verdict('SUPPRESS', String.raw`[^\n]*covered-by-memory`), meta('memory_ref', String.raw`project_q4_priorities\.md`, 2)]);

  triageCase('memory-reference-no-suppress-home', 'heldout', 'Only a reference memory matches: it informs but cannot suppress; CREATE.',
    'CREATE', HOME,
    [candidate('Rename the irrigation entities to one naming scheme', 'Two automations broke this month because the irrigation entities use three different naming patterns (valve.garden_front, valve.garden_back_zone2, switch.drip_line); renaming them to one scheme and updating the automations stops that.', 'operator-request')],
    [verdict('CREATE'), notContains('not-covered-by-memory', 'covered-by-memory')]);

  triageCase('weak-recurrence-shop', 'train', 'A single incident from an archived session: SUPPRESS weak-recurrence.', 'SUPPRESS … weak-recurrence', SHOP,
    [candidate('Auto-reply to tracking questions', 'One customer emailed twice about a tracking number on 12 September, in one session.', 'archived-session')],
    [verdict('SUPPRESS', String.raw`[^\n]*weak-recurrence`), meta('failed_condition', 'repeated-pattern', 1)]);

  triageCase('weak-consequence-home', 'train', 'Cosmetic idea with no real consequence: SUPPRESS weak-consequence.', 'SUPPRESS … weak-consequence', HOME,
    [candidate('Add a weather emoji to the morning brief header', 'The morning brief header is plain text; an emoji for the forecast would make it look friendlier.', 'capability-brainstorm')],
    [verdict('SUPPRESS', String.raw`[^\n]*weak-consequence`), meta('failed_condition', 'meaningful-consequence', 1)]);

  triageCase('not-actionable-shop', 'heldout', 'Vague improvement with no concrete change: SUPPRESS not-actionable.', 'SUPPRESS … not-actionable', SHOP,
    [candidate('Make the shop run better', 'Things felt hectic this week across orders, emails and stock; the shop should generally run more smoothly.', 'current-session')],
    [verdict('SUPPRESS', String.raw`[^\n]*not-actionable`), meta('failed_condition', 'operator-actionable', 1)]);

  triageCase('operator-conflict-home', 'train', 'OPERATOR.md lexically rules out more reports: metadata aligned: false with the excerpt.',
    'aligned: false and operator_excerpt quoting the reports line', HOME,
    [candidate('Weekly water usage report', 'The August water bill doubled and a dripping outdoor tap went unnoticed for three weeks; a weekly water report would have shown the jump.', 'scheduled-check/utilities')],
    [{ name: 'any-verdict', type: 'regex', target: 'last_message', pattern: String.raw`(^|\n)\s*(CREATE|SUPPRESS|DUPLICATE): `, weight: 1 },
      meta('aligned', 'false', 3), meta('operator_excerpt', String.raw`"?[^\n]*report`, 2)]);

  triageCase('blind-no-config-shop', 'heldout', 'The anchored root has no config.json: GATE_BLIND, no verdict.', 'GATE_BLIND: …', SHOP,
    [candidate('Reorder packaging before it runs out', 'Packaging ran out twice in September and orders shipped late.', 'scheduled-check/stock')],
    [verdict('GATE_BLIND'), notContains('no-real-verdict', String.raw`(^|\n)\s*(CREATE|SUPPRESS|DUPLICATE): `)],
    false);

  triageCase('batch-shop', 'train', 'Batch of two: one duplicate and one new problem, one block each.', 'DUPLICATE … PROP-021 and CREATE for the payout candidate', SHOP,
    [candidate('Chase wholesale invoices that are overdue', 'Three wholesale invoices are more than 20 days overdue this month.', 'scheduled-check/invoices'),
      candidate("Alert when the payment provider's payout is late", 'The weekly payout arrived 3 and 5 days late in the last two weeks and I only noticed when supplier payments bounced.', 'scheduled-check/payments')],
    [verdict('DUPLICATE', String.raw`Chase wholesale[^\n]*PROP-021`, 2, 'dup-first'),
      verdict('CREATE', 'Alert when the payment', 2, 'create-second')]);

  triageCase('ledger-exemption-home', 'heldout', 'A ledger-backed candidate is never suppressed covered-by-memory even when memory matches: CREATE.',
    'CREATE (not covered-by-memory)', HOME,
    [candidate('Notify when the freezer door is left open', 'The freezer door was left open for more than 10 minutes five times last week and food partly thawed once.', 'archived-session',
      undefined, 'state/observations.jsonl — freezer-door-open-10m recorded 5 times in 7 days')],
    [verdict('CREATE'), notContains('not-covered-by-memory', 'covered-by-memory')]);

  report('proposal-triage');
}
