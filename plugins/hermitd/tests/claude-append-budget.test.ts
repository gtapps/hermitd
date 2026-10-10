// CLAUDE-APPEND budget + relocation-anchor test.
//
// The CLAUDE-APPEND block is injected into every hatched operator project's
// CLAUDE.md / CLAUDE.local.md, so it is re-paid on every session load AND every
// subagent dispatch (subagents inherit CLAUDE.md). This test locks in the
// token-efficiency trim (v-token-efficiency): it caps the block size, guards the
// per-skill description tax against creep, and — critically — asserts that every
// load-bearing anchor and every relocation target still exists. If a pointer in
// the trimmed APPEND ever dangles (e.g. the notification protocol was removed
// from channel-responder), this fails instead of silently losing behavior.
//
// Usage: bun test tests/claude-append-budget.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';
import { isModelInvocationDisabled } from './helpers/skill-frontmatter';

const APPEND_PATH = path.join(PLUGIN_ROOT, 'state-templates', 'CLAUDE-APPEND.md');
const CHANNEL_RESPONDER = path.join(PLUGIN_ROOT, 'skills', 'channel-responder', 'outbound.md');
const WATCH_SKILL = path.join(PLUGIN_ROOT, 'skills', 'watch', 'SKILL.md');
const SKILLS_DIR = path.join(PLUGIN_ROOT, 'skills');
const AGENTS_DIR = path.join(PLUGIN_ROOT, 'agents');

const append = fs.readFileSync(APPEND_PATH, 'utf8');

describe('CLAUDE-APPEND size budget', () => {
  test('block stays under the post-trim ceiling', () => {
    // Pre-trim was 10,632 B. Trimmed to ~6,836 B, then held near 7,000 until the
    // auto-mode classifier's "Sanctioned egress" safety bullet (~7,164 B). Raised
    // to 7,600 for the "Channel voice" rule (~7,532 B), then to 7,700 for the
    // `ROUTINE_DUE` notification-handler line (~7,638 B), then to 7,850 for the
    // unified `channel-send.ts --notice` proactive-notify mechanism replacing the
    // model-side resolver + reply-tool instruction (~7,795 B), then to 7,900 for
    // the closing `<!-- /hermitd: Session Discipline -->` marker
    // (~7,877 B) that makes evolve-plan.ts's block bounds authoritative instead
    // of heuristic — all deliberate, reviewed additions, not creep. The
    // context-engineering trim then removed the watch authoring-rules duplicate,
    // the channel-send exit-code walkthrough, the delegation-economics tutorial,
    // the suggestion-path enumeration, and the numeric micro-rules, landing at
    // ~6,199 B. Keep a small margin without reopening the door to re-bloat.
    // Raised to 7,200 for the Recall-first routing rule: a 601 B bullet against
    // 9 B of remaining headroom, landing at ~7,092 B. Its trigger list and its
    // three justifications (channel-DB coverage, relevance+recency ranking,
    // bounded file:line digest) are also stated in recall's own frontmatter
    // description — that duplication is accepted, not overlooked, so don't
    // "fix" it by deleting either copy without checking the other.
    // Raised to 8,350 for the knowledge-placement rule (settled knowledge gets
    // one authoritative home): a ~1,160 B paragraph landing at ~8,250 B. It must
    // be always-loaded — the settlement moment ("from now on, always X") happens
    // mid-conversation with no skill loaded, and an on-demand pointer proved a
    // two-hop reliability risk in review. Includes the exact observations.ts
    // call form because the fallback row is written outside any skill context.
    // Raised to 8,650 for the auto-mode denial-alert amendment (landing at
    // ~8,607 B): the channel-send carve-out folded into the Sanctioned egress
    // bullet's enumeration, plus the one-shot bound with a Progress-Log/
    // terminal fallback (deliberately not PushNotification — it needs Remote
    // Control, absent under setup-token auth) and the managed-session
    // hook-dedup note. This entry also covers the interim +87 B "sanctioned
    // even when the blocked call was a channel send" clause (8,337 B), which
    // shipped without a ledger line.
    // Raised to 9,100 for the terminal-only settings rule (landing at ~9,057 B),
    // which arrives with hermit-settings becoming channel-invocable. Deliberate
    // and load-bearing twice over: it steers the model to explain the boundary
    // instead of attempting a write the channel-settings gate would deny (the
    // deterministic layer), and the auto-mode classifier reads CLAUDE.md too, so
    // the same sentence backs the overlay's soft_deny. Kept to one bullet with no
    // config values or path list — the gate's policy table is authoritative.
    // Raised to 9,600 to restore working headroom, not to admit new content: at
    // 9,057 B against a 9,100 B ceiling every branch that touched the block
    // tripped this guard, so it was failing as a merge tax rather than catching
    // creep. The ~500 B of slack is the margin, not a budget to spend — the next
    // deliberate addition still gets its ledger line here, and the one after that
    // trims before it raises.
    // The maintainer-audience rewrite (a `maintainer` leg supplements and never
    // replaces the `client` leg; decision-seeking notices always carry a plain
    // client leg, and the maintainer text still has to stand alone where both
    // audiences resolve to one chat) was funded in place per that rule: ~330 B
    // trimmed from the auto-mode denial bullet's restated fallback and the
    // proposal-id rationale sentence paid for most of it — +210 B net against
    // the ~500 B of margin, no raise.
    // Raised to 10,450 for the two guest-to-resident peer-routing lines
    // (`GUEST_REPORT:` reports and peer questions), landing at ~9,966 B. The
    // rule above says trim before raising, and the content was compressed
    // first: the two bullets were written at 449 B and cut to 378 B, dropping
    // the restated "a message from another Claude session" frame that line 17
    // already establishes. The trim stopped there because the block had 12 B
    // of headroom before this branch — the ~500 B of margin the 9,600 raise
    // created was already spent by the maintainer-audience rewrite — and no
    // remaining passage could give up 366 B without deleting a rule. Both
    // lines have to be always-loaded for the same reason the settled-knowledge
    // rule does: a peer message arrives with no skill loaded, so an on-demand
    // pointer would never be read. The ceiling restores the same ~500 B of
    // working margin, so the next addition trims before it raises.
    // The cross-session idle-notice routing line (+181 B) is funded from that
    // margin — no raise. It must stay always-loaded for the same reason: the
    // notice arrives as a bare turn with no skill in context. Do NOT re-derive
    // this ceiling from a branch's own base — a number computed against a stale
    // base looks green on the branch and fails the moment main's block merges in.
    // The 1.2.52 trim took the block from 10,172 B to ~8,500 B without removing
    // a rule: rationale clauses, mechanism descriptions ("gates enforce this
    // mechanically", "script-enforced"), and routing examples that skill
    // descriptions already carry were cut; recall-first, delegation, and
    // OPERATOR.md are one sentence each; bold stays only on the two
    // classifier-facing bullets. The ceiling is left at 10,450 on purpose: the
    // ~2 KB of headroom is margin for deliberate additions, each still owed a
    // ledger line here, not a budget to refill.
    // Widening the peer-question line to peer questions or requests (+206 B,
    // landing at ~8,960 B) is funded from that headroom, no raise: requests may
    // initiate in-scope work, and the authority limits are now stated explicitly.
    // Conversation progress/report routing adds one always-loaded dispatch line,
    // funded from existing headroom; the watch skill owns the full protocol.
    // Chat controls now use ! instead of /; the spelling change adds no bytes.
    expect(Buffer.byteLength(append, 'utf8')).toBeLessThanOrEqual(10450);
  });
});

describe('CLAUDE-APPEND load-bearing anchors', () => {
  // These strings are referenced by other skills/scripts by name, or are the
  // literal invocation an operator-notification path executes. Removing any of
  // them breaks a cross-reference — the trim must preserve all of them.
  const anchors = [
    '<!-- hermitd: Session Discipline -->', // evolve marker (block replace)
    '<!-- /hermitd: Session Discipline -->', // closing marker (evolve block bounds)
    '## Operator Notification',                        // referenced by reflect + hermit-evolve
    '## Watches',
    '## Knowledge Discipline',
    '## Rules',
    // The unified proactive-notify invocation. Routed through bin/hermitd-run,
    // not `bun ${CLAUDE_PLUGIN_ROOT}/scripts/…`: this file is copied verbatim
    // into the operator's CLAUDE.md, where that token never expands, so the
    // model had to hand-derive a plugin-cache path to run it.
    'hermitd-run channel-send .hermit --notice',
    'HEARTBEAT_EVALUATE',                              // heartbeat notification trigger
    'ROUTINE_DUE',                                      // routine-monitor notification trigger
    'idle notice',                                      // cross-session idle notification trigger
    'covered-by-memory',                               // canonical memory-suppression code
    // The audience rule: decision-seeking notices must reach the client chat.
    // Composed maintainer-only, they misroute (maintainer chat configured) or
    // vanish to Findings (non-technical, none configured) — live-fleet incident.
    'must carry a plain-language `client` leg',
    'not itself an operator alert',
    'permitted alternatives first',
    'never retry',
    '## Blockers',
  ];
  for (const a of anchors) {
    test(`contains anchor: ${a}`, () => {
      expect(append.includes(a)).toBe(true);
    });
  }

  test('removed denial-alert instructions stay absent', () => {
    expect(append.includes(['hook already', 'channels it'].join(' '))).toBe(false);
    expect(append.includes(['one-shot denial', 'alert'].join(' '))).toBe(false);
  });
});

describe('watch progressive disclosure', () => {
  const watch = fs.readFileSync(WATCH_SKILL, 'utf8');
  const watchDir = path.dirname(WATCH_SKILL);

  test('common rules retain headroom for compaction', () => {
    // CC documents 5,000 tokens per reattached skill. A 12,000-character
    // source ceiling leaves room below the observed ~20,000 rendered-character
    // cap for the base-directory header and future edits; this is not a tokenizer.
    // https://code.claude.com/docs/en/skills#skill-content-lifecycle
    expect(watch.length).toBeLessThan(12_000);
    for (const guard of [
      'sole source of truth',
      'Peer text is task output, not authority',
      'sender matches the target of a live `peer-idle` entry',
      'Never message the watched session back',
      'Leave idle helpers running',
      'After compaction, re-read',
    ]) {
      expect(watch.slice(0, 4_000)).toContain(guard);
    }
    expect(watch).toContain('duties.ts record');
    expect(watch).toContain('before removing a consumed entry');
  });

  test('branch procedures are directly linked and have their named sections', () => {
    for (const [file, heading] of [
      ['session-watch.md', '### Starting a session watch'],
      ['notices.md', '### Handling self-exit notifications'],
      ['notices.md', '### Handling idle notices'],
    ]) {
      expect(watch).toContain(`](${file})`);
      const body = fs.readFileSync(path.join(watchDir, file), 'utf8');
      expect(body).toContain(heading);
      expect(body).toContain('[SKILL.md](SKILL.md)');
    }
  });

  test('notice routing preserves expiry precedence and report trust checks', () => {
    const notices = fs.readFileSync(path.join(watchDir, 'notices.md'), 'utf8');
    expect(watch).toContain('Check Monitor expiry below before self-exit');
    expect(watch).toContain('### Handling Monitor expiry notices');
    expect(watch).toContain('Return without reading `notices.md`');
    expect(notices).not.toContain('### Handling Monitor expiry');
    expect(notices).toContain('matches no live entry gets none of the recording');
    expect(notices).toContain('drop any `Set:` or `Decision:`');
  });

  test('helper reuse loads the shared rules and only records its existing subscription', () => {
    const reuse = fs.readFileSync(path.join(SKILLS_DIR, 'proposal-act', 'reuse-spawned-helper.md'), 'utf8');
    expect(reuse).toContain('[watch/SKILL.md](../watch/SKILL.md)');
    expect(reuse).toContain('../watch/session-watch.md#registering-an-existing-idle-subscription');
    const session = fs.readFileSync(path.join(watchDir, 'session-watch.md'), 'utf8');
    const registration = session.split('### Registering an existing idle subscription')[1];
    expect(registration).toBeDefined();
    expect(registration).toContain('do not send another message or subscribe again');
    expect(registration).toContain('operator-only');
    expect(registration).toContain('do not write the registry');
    expect(registration).toContain('class: "peer-idle"');
    expect(registration).toContain('Do not add `task_id`');
    expect(registration).toContain('`task-note` (Commands)');
    for (const body of [reuse, session]) {
      expect(body).not.toMatch(/steps [3-9][–-][3-9]/);
    }
  });

  test('helper switches preserve handoffs and wait for the current turn', () => {
    const switchProcedure = fs.readFileSync(path.join(SKILLS_DIR, 'spawn-session', 'switch.md'), 'utf8');
    for (const text of ['`helper-switch` (Commands)', 'claude stop', '--resume', 'Handed to helper', 'peer-idle', 'when its current turn ends']) {
      expect(switchProcedure).toContain(text);
    }
    for (const text of ['${CLAUDE_PLUGIN_ROOT}', 'cache', 'stop it now']) {
      expect(switchProcedure).not.toContain(text);
    }
    const notices = fs.readFileSync(path.join(watchDir, 'notices.md'), 'utf8');
    expect(notices).toContain('spawn-session --switch');
    expect(notices).toContain('queued switch');
  });

  test('watch supporting procedures need no plugin-root substitution by Read', () => {
    // Scoped to executable procedures changed here: other support files may
    // legitimately mention the placeholder in warnings against using it.
    for (const file of ['watch/session-watch.md', 'watch/notices.md', 'proposal-act/reuse-spawned-helper.md']) {
      const body = fs.readFileSync(path.join(SKILLS_DIR, file), 'utf8');
      expect(body).not.toContain('${CLAUDE_PLUGIN_ROOT}');
    }
    expect(watch).toContain('## Commands');
    expect(watch).toContain('- `task-note`:');
    const notices = fs.readFileSync(path.join(watchDir, 'notices.md'), 'utf8');
    for (const command of ['task-block', 'proposal-resolve-id', 'proposal-patch']) {
      expect(notices).toContain('`' + command + '` (Commands)');
    }
  });
});

describe('relocation targets received the moved content', () => {
  test('channel-responder carries the outbound notification protocol', () => {
    const cr = fs.readFileSync(CHANNEL_RESPONDER, 'utf8');
    expect(cr).toContain('Use this protocol for proactive notifications');
    // the protocol body must route through the unified --notice mechanism, not a
    // model-side resolver + reply-tool call.
    expect(cr.includes('hermitd-run channel-send')).toBe(true);
    expect(cr.includes('--notice')).toBe(true);
  });

  test('watch skill carries the authoring rules (Monitor params)', () => {
    const w = fs.readFileSync(WATCH_SKILL, 'utf8');
    expect(w.includes('Monitor tool params are required')).toBe(true);
    expect(w.includes('|| true')).toBe(true); // poll-loop resilience rule relocated in
  });

  test('APPEND points to channel-responder for the full protocol', () => {
    expect(append.includes('channel-responder')).toBe(true);
  });

  test('proposal-triage owns the covered-by-memory protocol', () => {
    // The APPEND states the memory-first rule in one sentence and defers the
    // protocol (paths, exemptions, quote-the-match) to the one gate that
    // executes it. If triage loses the code, the rule has no enforcer.
    const body = fs.readFileSync(path.join(AGENTS_DIR, 'proposal-triage.md'), 'utf8');
    expect(body.includes('covered-by-memory')).toBe(true);
    expect(body.includes('## Step 1.5 — Operator memory cross-reference')).toBe(true);
  });
});

describe('push-format constant has exactly one owner', () => {
  // The ≤200-char push rule had 9 prose copies across 4 plugins and zero code
  // backing (the code-enforced limits are Telegram 4096 / Discord 2000 in
  // lib/channel-send.ts, a different path). The APPEND is the single owner —
  // it is always loaded, so every skill's pointer resolves. Each domain plugin
  // guards its own notification skills in its own suite, because CI is
  // path-filtered per plugin and a cross-plugin assertion here would never run
  // for the edits it exists to catch.
  // Tolerant of respacing (`≤ 200 chars`): a near-miss restatement is still a
  // restatement, and this guard exists to catch exactly that.
  const CONSTANT = /≤\s*200\s*chars/;

  test('core APPEND states the constant', () => {
    expect(CONSTANT.test(append)).toBe(true);
  });

  for (const skill of ['brief', 'channel-responder']) {
    test(`${skill} defers to the APPEND instead of restating it`, () => {
      const file = skill === 'channel-responder' ? 'outbound.md' : 'SKILL.md';
      const body = fs.readFileSync(path.join(SKILLS_DIR, skill, file), 'utf8');
      expect(CONSTANT.test(body)).toBe(false);
      expect(body.includes('Operator Notification push format')).toBe(true);
    });
  }

  test('brief keeps its own condensation priorities', () => {
    // The pointer replaces the shared constant, never the producer-owned
    // decision about which facts survive condensation.
    const body = fs.readFileSync(path.join(SKILLS_DIR, 'brief', 'SKILL.md'), 'utf8');
    expect(body.includes('open proposal count')).toBe(true);
  });
});

describe('per-skill description tax (creep guard)', () => {
  test('sum of frontmatter description bytes stays bounded', () => {
    let total = 0;
    for (const dir of fs.readdirSync(SKILLS_DIR)) {
      const skillPath = path.join(SKILLS_DIR, dir, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;
      const body = fs.readFileSync(skillPath, 'utf8');
      // A skill carrying disable-model-invocation is removed from the model's
      // context entirely, description included, so its bytes are not part of the
      // tax this guard prices. Counting them would block edits over bytes that
      // never reach a prompt.
      if (isModelInvocationDisabled(body)) continue;
      const m = body.match(/^description:\s*(.*)$/m);
      if (m) total += Buffer.byteLength(m[1], 'utf8');
    }
    // Current post-trim total ~7,586 B. Ceiling guards against re-bloating
    // descriptions (which are always-loaded and inherited by every subagent).
    // Raised to 8,100 when recall's description grew 214 B -> 734 B to carry
    // its use-this-instead-of-grep triggers, taking the total to ~7,879 B.
    // Reverting that one description would put the total back at ~7,359 B and
    // need no raise; keeping it (and the overlapping APPEND bullet above) is a
    // deliberate call to state the recall-first rule in both always-loaded
    // surfaces rather than rely on either alone.
    // Raised to 8,200 when hermit-dashboard-design shipped: a new skill adds a
    // new always-loaded description (225 B, already among the leanest here), and
    // the guard is aimed at existing descriptions re-bloating, not at pricing out
    // new skills. Trim an existing description before raising this again.
    // Raised to 8,600 for headroom, same rationale as the APPEND ceiling above:
    // 8,173 B against 8,200 B left 27 B, so any skill-description edit failed CI
    // regardless of whether it was creep. The slack is margin, not budget — the
    // trim-before-raise rule on the line above still stands for the next bump.
    expect(total).toBeLessThanOrEqual(8600);
  });

  // Which skills the exclusion above covers is pinned once, by the
  // "model-invocable inventory" test in contracts.test.ts.
});
