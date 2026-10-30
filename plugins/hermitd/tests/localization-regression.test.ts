// Regression guard: the English catalog must stay byte-for-byte the strings the
// deterministic senders emit on a stock install (language null, no messages
// file), whether a sentence is one template or is filled from locked values
// (commands, URLs, the reauth keyword). A change to any of them must fail loudly
// rather than silently drift the wire.

import { describe, test, expect } from 'bun:test';
import { EN_MESSAGES as m, LOCKED } from '../scripts/lib/messages';
import { pauseReasonLabel } from '../scripts/lib/pause';

describe('en catalog byte-identity', () => {
  test('pause reason labels', () => {
    expect(pauseReasonLabel('budget')).toBe('a budget cap');
    expect(pauseReasonLabel('watchdog')).toBe('the watchdog');
    expect(pauseReasonLabel('operator')).toBe('your request');
  });

  test('status lines', () => {
    expect(m.t('status_paused_until_resume', { label: 'X' })).toBe('Paused (X) until you resume it.');
    expect(m.t('status_paused_until_date', { label: 'X', boundary: 'B' })).toBe('Paused (X) until B.');
    expect(m.t('status_working_on', { task: 'T' })).toBe('Working on T.');
    expect(m.t('status_working')).toBe('Working.');
    expect(m.t('status_idle')).toBe('Idle.');
    expect(m.t('status_one_approval', { id: 'ID' })).toBe('1 approval waiting (reply "ID yes/no").');
    expect(m.t('status_n_approvals', { n: 3 })).toBe('3 approvals waiting.');
    expect(m.t('status_next_routine', { hh: '08', mm: '30', id: 'reflect' })).toBe('Next routine: 08:30 (reflect).');
    expect(m.t('status_all_quiet')).toBe('All quiet — nothing in progress, nothing waiting.');
  });

  test('spend cap status line', () => {
    expect(m.t('spend_label_daily')).toBe('Today');
    expect(m.t('spend_label_weekly')).toBe('This week');
    expect(m.t('spend_label_monthly')).toBe('This month');
    expect(m.t('spend_cap_status', { label: 'Today', spend: '$0.00', cap: '$5.00' })).toBe('Today: $0.00 of $5.00 cap.');
  });

  test('budget clauses and frames', () => {
    expect(m.t('budget_period_daily')).toBe("today's");
    expect(m.t('budget_period_weekly')).toBe("this week's");
    expect(m.t('budget_period_monthly')).toBe("this month's");
    expect(m.t('budget_clause', { period: "today's", spend: '1.05', cap: '1.00', pct: 105 }))
      .toBe("today's spend is $1.05 of your $1.00 cap (105%)");
    expect(m.t('budget_cap_reached_prefix')).toBe('Budget cap reached — ');
    expect(m.t('budget_also_approaching')).toBe('. Also approaching: ');
    expect(m.t('budget_paused_until_suffix', { boundary: 'B' })).toBe(". I've paused until B");
    expect(m.t('budget_heads_up_prefix')).toBe('Heads up — ');
  });

  test('deny maintainer frame', () => {
    expect(m.t('deny_base', { tool: 'Bash' })).toBe('Auto-mode denied: Bash');
    expect(m.t('deny_suppressed', { count: 4 })).toBe(' (+4 more in the previous 30 min)');
    expect(m.t('deny_tail')).toBe('. Session continues; the agent will try another way. If it was intended, tell the agent in chat.');
  });

  test('mint prompts', () => {
    expect(m.t('mint_ack_prompt', { keyword: LOCKED.keyword })).toBe(
      "Your agent's Claude login has expired, so it can't work until it's renewed. " +
      "Reply 'reauth' in the chat where you normally talk to me and I'll send you a one-time sign-in link.",
    );
    expect(m.t('mint_open_link', { url: 'URL' })).toBe('Open this link to sign in, then send me the code it gives you:\nURL');
    expect(m.t('mint_failed')).toBe("That sign-in didn't complete. Nothing changed — we can try again whenever you're ready.");
    expect(m.t('mint_signed_in', { date: '5 July 2026' })).toBe(
      "You're signed back in. Nothing else to do — the next renewal is due 5 July 2026, and I'll ask you then.",
    );
  });

  test('watchdog lifecycle messages', () => {
    expect(m.t('watchdog_restart_resumed', { time: '08:30', cause: 'it had frozen' })).toBe(
      'Attempting to restart your agent at 08:30: it had frozen. Its conversation is restored where possible, but work in flight since the last save may not have carried over, so it will re-check its work before continuing.',
    );
    expect(m.t('watchdog_cause_not_running')).toBe("it wasn't running");
    expect(m.t('watchdog_cause_frozen')).toBe('it had frozen');
    expect(m.t('watchdog_wedge', { time: '08:30' })).toBe(
      "Your agent hasn't responded in a while — checking on it now (08:30). If it has to be restarted, work in flight may be lost.",
    );
    expect(m.t('watchdog_paused_until_resume', { label: 'X' })).toBe('Your agent is paused (X) until you resume it.');
    expect(m.t('watchdog_paused_until_date', { label: 'X', boundary: 'B' })).toBe('Your agent is paused (X) until B.');
    expect(m.t('watchdog_stall_question', { time: '08:30' })).toBe(
      "Your agent is waiting on a question it can't ask over chat — open the terminal or Claude app to answer (08:30).",
    );
    expect(m.t('watchdog_stall_permission', { time: '08:30' })).toBe(
      'The agent asked for permission to continue and is waiting for an answer (08:30). It will pick up where it left off once someone approves.',
    );
    expect(m.t('watchdog_lapsed_login', { time: '08:30', fix: 'FIX' })).toBe(
      "Your Claude login has expired, so your agent can't do any work until you sign in again (08:30). FIX",
    );
    expect(m.t('watchdog_orphan', { time: '08:30', command: LOCKED.orphan_command })).toBe(
      "Your agent's session ended but a process may still be running (08:30). If it keeps replying, stop it from the terminal: run `pgrep -af \"claude --channels\"` and kill that PID.",
    );
    expect(m.t('watchdog_api_unavailable', { time: '08:30', url: LOCKED.status_url })).toBe(
      'Your agent is affected by a temporary Claude service outage (08:30). It will resume on its own. https://status.claude.com',
    );
  });

  // The lapsed-login fix lines are the one place a channel message has to name a
  // command: the sign-in happens on the machine the hermit runs on. The commands are
  // locked placeholder values, so no translation can drop or garble them.
  test('watchdog lapsed-login fix lines carry the runnable commands', () => {
    expect(m.t('watchdog_lapsed_login_fix_docker', { login: LOCKED.docker_login, restart: LOCKED.docker_restart }))
      .toBe('This one needs the machine it runs on: `hermitd docker login`, then `hermitd restart`.');
    expect(m.t('watchdog_lapsed_login_fix_host', {
      claude: LOCKED.host_claude, login: LOCKED.host_login, stop: LOCKED.host_stop, start: LOCKED.host_start,
    })).toBe('This one needs the machine it runs on: run `claude` in its project folder, type `/login`, then restart it with `hermitd stop` and `hermitd start`.');
  });
});
