#!/usr/bin/env python3
"""Generate proposal-triage eval cases into <suite>/proposal-triage/."""
import json, os, sys, textwrap

def indent(s, n=4):
    return textwrap.indent(s, ' ' * n)

def yq(s):
    return "'" + s.replace("'", "''") + "'"

def prop(pid, slug, status, title, problem, created='2026-08-14T10:00:00+01:00', tags=()):
    fname = f'{pid}-{slug}-100000.md'
    body = (f'---\nid: {pid}-{slug}-100000\ntitle: "{title}"\nstatus: {status}\nsource: auto-detected\ncreated: {created}\n'
            f'category: improvement\ntags: {json.dumps(list(tags))}\n---\n# Proposal: {pid} — {title}\n\n## Problem\n{problem}\n\n'
            f'## Proposed Solution\nSee title.\n')
    entry = {"id": f'{pid}-{slug}-100000', "file": fname, "status": status, "source": "auto-detected", "category": "improvement",
             "title": title, "created": created, "tags": list(tags)}
    return fname, body, entry

HOME = dict(
    proposals=[
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
    operator='# Operator\n\nHousehold of two adults and a cat. Prefers short messages.\n\n## Preferences\n- Don\'t add more daily or weekly reports; the morning brief is enough.\n- Never unlock doors automatically.\n',
    memory={
        'feedback_no_camera_automations.md': '---\nname: no-camera-automations\ndescription: Do not propose automations that use the indoor cameras\ntype: feedback\n---\n\nDon\'t propose automations driven by the indoor cameras.\n**Why:** privacy; the cameras are for when the house is empty.\n**How to apply:** treat camera-based ideas as already decided against.\n',
        'feedback_fewer_phone_notifications.md': '---\nname: fewer-phone-notifications\ndescription: No new phone notifications for routine household events\ntype: feedback\n---\n\nDon\'t add new phone notifications for routine household events.\n**Why:** notification fatigue.\n**How to apply:** prefer the morning brief over a push.\n',
        'reference_irrigation_entities.md': '---\nname: irrigation-entities\ndescription: Entity names for the garden irrigation valves and the rain sensor\ntype: reference\n---\n\nValves: valve.garden_front, valve.garden_back_zone2, switch.drip_line. Rain sensor: binary_sensor.rain_gauge.\n',
        'user_household.md': '---\nname: household\ndescription: Who lives in the house\ntype: user\n---\n\nTwo adults and a cat.\n',
    },
    compiled={'topic-energy-baseline.md': '---\ntitle: Energy usage baseline\ntype: topic\ncreated: 2026-09-01T09:00:00+01:00\ntags: [energy]\n---\n\nAverage daily use 9.4 kWh.\n'},
)

SHOP = dict(
    proposals=[
        prop('PROP-021', 'unpaid-invoice-reminders', 'proposed', 'Remind customers about invoices unpaid after 7 days',
             'Wholesale invoices go unpaid for weeks because nobody chases them.'),
        prop('PROP-024', 'weekly-sales-summary', 'dismissed', 'Weekly sales summary to the channel',
             'No weekly overview of sales.'),
        prop('PROP-026', 'nightly-db-backup', 'resolved', 'Back up the shop database nightly',
             'The order database had no backup.'),
        prop('PROP-028', 'low-stock-reorder', 'accepted', 'Reorder alert when stock falls below 5 units',
             'Popular teas sold out before anyone noticed.'),
    ],
    operator='# Operator\n\nRuns a small online tea shop alone.\n\n## Preferences\n- I decided not to send automated messages to customers without my review.\n- Keep answers short.\n',
    memory={
        'feedback_no_social_posting.md': '---\nname: no-social-posting\ndescription: Do not propose posting to social media on my behalf\ntype: feedback\n---\n\nDon\'t propose posting to social media for me.\n**Why:** I want my own voice there.\n**How to apply:** suppress social-posting ideas.\n',
        'project_q4_priorities.md': '---\nname: q4-priorities\ndescription: Q4 focus is wholesale orders; the website redesign is postponed to next year\nmetadata:\n  type: project\n---\n\nQ4 2026: focus on wholesale orders. The website and homepage redesign is postponed until 2027.\n**Why:** cash flow.\n**How to apply:** no redesign work this quarter.\n',
    },
    compiled={'topic-wholesale-pipeline.md': '---\ntitle: Wholesale pipeline\ntype: topic\ncreated: 2026-09-10T09:00:00+01:00\ntags: [wholesale]\n---\n\nFour cafes ordering monthly.\n'},
)

def scaffold(universe, with_config=True):
    files = {}
    root = '.hermit'
    if with_config:
        files[f'{root}/config.json'] = '{"agent_name": "assistant", "timezone": "Europe/Lisbon"}\n'
    entries = []
    for fname, body, entry in universe['proposals']:
        files[f'{root}/proposals/{fname}'] = body
        entries.append(entry)
    files[f'{root}/state/proposals-index.json'] = json.dumps({"updated": "2026-10-01T08:00:00Z", "count": len(entries), "proposals": entries}, indent=2) + '\n'
    files[f'{root}/OPERATOR.md'] = universe['operator']
    idx = []
    for fname, body in universe['memory'].items():
        desc = [l for l in body.splitlines() if l.startswith('description:')][0].split(':', 1)[1].strip()
        title = [l for l in body.splitlines() if l.startswith('name:')][0].split(':', 1)[1].strip()
        files[f'memory/{fname}'] = body
        idx.append(f'- [{title}]({fname}) — {desc}')
    files['memory/MEMORY.md'] = '\n'.join(idx) + '\n'
    for fname, body in universe['compiled'].items():
        files[f'{root}/compiled/{fname}'] = body
    sh = ['#!/usr/bin/env bash', '# Seeds a hermit state dir and auto-memory for this case (runs only with --scaffold).', 'set -e']
    for path in sorted(files):
        sh.append(f'mkdir -p "{os.path.dirname(path)}"')
        sh.append(f"cat > '{path}' <<'HERMIT_FIXTURE'\n{files[path]}HERMIT_FIXTURE")
    return '\n'.join(sh) + '\n'

CALLER = ("You are running proposal-create's triage step for this hermit. Dispatch the `hermitd:proposal-triage` agent with the "
          "input below. Replace {ROOT} with the absolute path of `.hermit` in your current working directory and {MEM} with the "
          "absolute path of the `memory` directory beside it (also directly in your working directory); change nothing else. Then reply with the agent's output verbatim, with nothing added.\n\n<input>\n")

def candidate(title, evidence, source=None, origin=None, artifact=None):
    lines = [f'Title: {title}']
    if source: lines.append(f'Evidence Source: {source}')
    if origin: lines.append(f'Evidence Origin: {origin}')
    lines.append(f'Evidence: {evidence}')
    if artifact: lines.append(f'Artifact: {artifact}')
    return '\n'.join(lines)

def verdict(kind, rest='', w=3, name=None):
    return dict(name=name or f'verdict-{kind.lower()}', type='regex', target='last_message', pattern=r'(^|\n)\s*' + kind + r': ' + rest, weight=w)

def meta(key, val, w=1):
    return dict(name=f'meta-{key}', type='regex', target='last_message', pattern=r'(^|\n)\s*' + key + r': ' + val, weight=w)

def grader_yaml(g):
    out = [f"  - name: {g['name']}"]
    for k, v in g.items():
        if k == 'name': continue
        out.append(f"    {k}: {v}" if isinstance(v, (int, float)) else f"    {k}: {yq(str(v))}")
    return '\n'.join(out)

COMMON = [
    dict(name='dispatched-triage', type='tool_used', tool='Agent', input_match=r'proposal-triage'),
    dict(name='verdict-first', type='regex', target='last_message', pattern=r'^\s*`*\s*(CREATE|SUPPRESS|DUPLICATE|GATE_BLIND): '),
]

def case(name, tag, desc, expected, universe, cands, graders, with_config=True):
    d = os.path.join(OUT, name)
    os.makedirs(d, exist_ok=True)
    prompt = CALLER + 'Anchor: root={ROOT} memory_dir={MEM}\n' + '\n\n'.join(cands) + '\n</input>'
    y = ['schema_version: "1.1"', f'name: {name}', f'description: {yq(desc)}', f'tags: [proposal-triage, {tag}]',
         f'expected_outcome: {yq(expected)}', 'context:', '  scaffold_script: scaffold.sh', 'execution:', '  max_turns: 8',
         '  timeout_seconds: 400', '  allowed_tools: [Agent, Read, Glob, Grep]', '  prompt: |', indent(prompt), 'graders:']
    y += [grader_yaml(g) for g in COMMON + graders]
    open(os.path.join(d, 'case.yaml'), 'w').write('\n'.join(y) + '\n')
    p = os.path.join(d, 'scaffold.sh')
    open(p, 'w').write(scaffold(universe, with_config))
    os.chmod(p, 0o755)

if __name__ == '__main__':
    SUITE = sys.argv[1]
    OUT = os.path.join(SUITE, 'proposal-triage')

    case('dup-proposed-home', 'train', 'Same problem as an open proposed proposal: DUPLICATE.', 'DUPLICATE: … — PROP-009', HOME,
         [candidate('Skip watering the garden on rainy days', 'The irrigation ran on 4 of the last 6 rainy days (rain gauge above 5 mm), soaking the lawn and wasting water.', 'scheduled-check/irrigation')],
         [verdict('DUPLICATE', r'[^\n]*PROP-009')])

    case('dup-dismissed-shop', 'heldout', 'Same problem as a dismissed proposal: DUPLICATE, not a fresh CREATE.', 'DUPLICATE: … — PROP-024', SHOP,
         [candidate('Send me a weekly summary of sales', 'Sales questions came up in three conversations this month; a weekly sales summary posted to the channel would answer them.', 'capability-brainstorm')],
         [verdict('DUPLICATE', r'[^\n]*PROP-024')])

    case('dup-deferred-home', 'heldout', 'Same problem as a deferred proposal: DUPLICATE.', 'DUPLICATE: … — PROP-013', HOME,
         [candidate('Write household alerts in Portuguese', 'Two household members asked for alerts in Portuguese; English notices were misread twice.', 'operator-request')],
         [verdict('DUPLICATE', r'[^\n]*PROP-013')])

    case('resolved-recurs-home', 'train', 'Same problem as a resolved proposal that came back: not DUPLICATE; CREATE with closest_prop.',
         'CREATE plus closest_prop: PROP-004', HOME,
         [candidate('Washer-finished notices stopped arriving', 'Since the washer firmware update, the finished notice failed on 3 of the last 5 loads and laundry stayed wet overnight twice. Re-pointing the automation to the new power-sensor entity fixes it.', 'current-session')],
         [verdict('CREATE'), meta('closest_prop', r'PROP-004', 2),
          dict(name='not-duplicate', type='regex', target='last_message', pattern=r'(^|\n)\s*DUPLICATE:', match='not_contains', weight=2)])

    case('shared-surface-shop', 'heldout', 'Shares the invoice surface with a proposed proposal but solves a different problem: CREATE.',
         'CREATE (not DUPLICATE of PROP-021)', SHOP,
         [candidate('Alert me when a customer card payment fails', 'The payment provider declined 6 card payments in September and I learned about each only when the customer emailed, days later; two orders were lost. A same-day alert from the provider webhook would let me follow up.', 'scheduled-check/payments')],
         [verdict('CREATE'), dict(name='not-duplicate', type='regex', target='last_message', pattern=r'(^|\n)\s*DUPLICATE:', match='not_contains', weight=2)])

    case('memory-feedback-home', 'train', 'Operator feedback memory already rules the idea out: SUPPRESS covered-by-memory with memory_ref.',
         'SUPPRESS … covered-by-memory, memory_ref: feedback_no_camera_automations.md', HOME,
         [candidate("Use the living-room camera to tell when the cat's bowl is empty", "The cat's bowl was found empty at dinner twice this week; the living-room camera can see the bowl.", 'capability-brainstorm')],
         [verdict('SUPPRESS', r'[^\n]*covered-by-memory'), meta('memory_ref', r'feedback_no_camera_automations\.md', 2)])

    case('memory-project-nested-shop', 'heldout', 'A project memory whose type sits under metadata covers the idea: SUPPRESS covered-by-memory.',
         'SUPPRESS … covered-by-memory, memory_ref: project_q4_priorities.md', SHOP,
         [candidate('Redesign the shop homepage this quarter', 'The homepage still shows the summer collection and the bounce rate rose from 41% to 55% over two months.', 'capability-brainstorm')],
         [verdict('SUPPRESS', r'[^\n]*covered-by-memory'), meta('memory_ref', r'project_q4_priorities\.md', 2)])

    case('memory-reference-no-suppress-home', 'heldout', 'Only a reference memory matches: it informs but cannot suppress; CREATE.',
         'CREATE', HOME,
         [candidate('Rename the irrigation entities to one naming scheme', 'Two automations broke this month because the irrigation entities use three different naming patterns (valve.garden_front, valve.garden_back_zone2, switch.drip_line); renaming them to one scheme and updating the automations stops that.', 'operator-request')],
         [verdict('CREATE'), dict(name='not-covered-by-memory', type='regex', target='last_message', pattern=r'covered-by-memory', match='not_contains', weight=2)])

    case('weak-recurrence-shop', 'train', 'A single incident from an archived session: SUPPRESS weak-recurrence.', 'SUPPRESS … weak-recurrence', SHOP,
         [candidate('Auto-reply to tracking questions', 'One customer emailed twice about a tracking number on 12 September, in one session.', 'archived-session')],
         [verdict('SUPPRESS', r'[^\n]*weak-recurrence'), meta('failed_condition', r'repeated-pattern', 1)])

    case('weak-consequence-home', 'train', 'Cosmetic idea with no real consequence: SUPPRESS weak-consequence.', 'SUPPRESS … weak-consequence', HOME,
         [candidate('Add a weather emoji to the morning brief header', 'The morning brief header is plain text; an emoji for the forecast would make it look friendlier.', 'capability-brainstorm')],
         [verdict('SUPPRESS', r'[^\n]*weak-consequence'), meta('failed_condition', r'meaningful-consequence', 1)])

    case('not-actionable-shop', 'heldout', 'Vague improvement with no concrete change: SUPPRESS not-actionable.', 'SUPPRESS … not-actionable', SHOP,
         [candidate('Make the shop run better', 'Things felt hectic this week across orders, emails and stock; the shop should generally run more smoothly.', 'current-session')],
         [verdict('SUPPRESS', r'[^\n]*not-actionable'), meta('failed_condition', r'operator-actionable', 1)])

    case('operator-conflict-home', 'train', 'OPERATOR.md lexically rules out more reports: metadata aligned: false with the excerpt.',
         'aligned: false and operator_excerpt quoting the reports line', HOME,
         [candidate('Weekly water usage report', 'The August water bill doubled and a dripping outdoor tap went unnoticed for three weeks; a weekly water report would have shown the jump.', 'scheduled-check/utilities')],
         [dict(name='any-verdict', type='regex', target='last_message', pattern=r'(^|\n)\s*(CREATE|SUPPRESS|DUPLICATE): ', weight=1),
          meta('aligned', r'false', 3), meta('operator_excerpt', r'"?[^\n]*report', 2)])

    case('blind-no-config-shop', 'heldout', 'The anchored root has no config.json: GATE_BLIND, no verdict.', 'GATE_BLIND: …', SHOP,
         [candidate('Reorder packaging before it runs out', 'Packaging ran out twice in September and orders shipped late.', 'scheduled-check/stock')],
         [verdict('GATE_BLIND'), dict(name='no-real-verdict', type='regex', target='last_message', pattern=r'(^|\n)\s*(CREATE|SUPPRESS|DUPLICATE): ', match='not_contains', weight=2)],
         with_config=False)

    case('batch-shop', 'train', 'Batch of two: one duplicate and one new problem, one block each.', 'DUPLICATE … PROP-021 and CREATE for the payout candidate', SHOP,
         [candidate('Chase wholesale invoices that are overdue', 'Three wholesale invoices are more than 20 days overdue this month.', 'scheduled-check/invoices'),
          candidate("Alert when the payment provider's payout is late", 'The weekly payout arrived 3 and 5 days late in the last two weeks and I only noticed when supplier payments bounced.', 'scheduled-check/payments')],
         [verdict('DUPLICATE', r'Chase wholesale[^\n]*PROP-021', 2, 'dup-first'),
          verdict('CREATE', r"Alert when the payment", 2, 'create-second')])

    case('ledger-exemption-home', 'heldout', 'A ledger-backed candidate is never suppressed covered-by-memory even when memory matches: CREATE.',
         'CREATE (not covered-by-memory)', HOME,
         [candidate('Notify when the freezer door is left open', 'The freezer door was left open for more than 10 minutes five times last week and food partly thawed once.', 'archived-session',
                    artifact='state/observations.jsonl — freezer-door-open-10m recorded 5 times in 7 days')],
         [verdict('CREATE'), dict(name='not-covered-by-memory', type='regex', target='last_message', pattern=r'covered-by-memory', match='not_contains', weight=2)])

    print('ok', len(os.listdir(OUT)))
