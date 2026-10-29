// Regression guard: the `en` catalog bodies must stay byte-for-byte the strings
// the deterministic senders emitted before scripts/lib/messages.ts existed, so a
// stock install (language null, technical, no maintainer channel) speaks exactly
// as it did pre-refactor. MINT.ackPrompt is excluded because the mint ack was
// unified to one destination-agnostic wording and is covered by its own tests.
// Every other `en` literal is pinned below;
// a change to any of them must fail loudly rather than silently drift the wire.

import { describe, test, expect } from 'bun:test';
import { PAUSE, STATUS, SPEND, BUDGET, DENY, MINT, WATCHDOG } from '../scripts/lib/messages';

describe('en catalog byte-identity (pre-refactor literals)', () => {
  test('PAUSE reason labels', () => {
    expect(PAUSE.en.reasonLabel('budget')).toBe('a budget cap');
    expect(PAUSE.en.reasonLabel('watchdog')).toBe('the watchdog');
    expect(PAUSE.en.reasonLabel('operator')).toBe('your request');
  });

  test('STATUS lines', () => {
    expect(STATUS.en.pausedUntilResume('X')).toBe('Paused (X) until you resume it.');
    expect(STATUS.en.pausedUntilDate('X', 'B')).toBe('Paused (X) until B.');
    expect(STATUS.en.workingOn('T')).toBe('Working on T.');
    expect(STATUS.en.redactedWorking()).toBe('Working.');
    expect(STATUS.en.redactedIdle()).toBe('Idle.');
    expect(STATUS.en.oneApproval('ID')).toBe('1 approval waiting (reply "ID yes/no").');
    expect(STATUS['pt-PT'].oneApproval('ID')).toBe('1 aprovação pendente (responda "ID sim/não").');
    expect(STATUS.en.nApprovals(3)).toBe('3 approvals waiting.');
    expect(STATUS.en.nextRoutine('08', '30', 'reflect')).toBe('Next routine: 08:30 (reflect).');
    expect(STATUS.en.allQuiet()).toBe('All quiet — nothing in progress, nothing waiting.');
  });

  test('SPEND cap status line', () => {
    expect(SPEND.en.capLabel('daily')).toBe('Today');
    expect(SPEND.en.capLabel('weekly')).toBe('This week');
    expect(SPEND.en.capLabel('monthly')).toBe('This month');
    expect(SPEND.en.capStatus('Today', '$0.00', '$5.00')).toBe('Today: $0.00 of $5.00 cap.');
  });

  test('BUDGET clauses and frames', () => {
    expect(BUDGET.en.periodPossessive('daily')).toBe("today's");
    expect(BUDGET.en.periodPossessive('weekly')).toBe("this week's");
    expect(BUDGET.en.periodPossessive('monthly')).toBe("this month's");
    expect(BUDGET.en.clause("today's", 1.05, 1.0, 105)).toBe("today's spend is $1.05 of your $1.00 cap (105%)");
    expect(BUDGET.en.capReachedPrefix()).toBe('Budget cap reached — ');
    expect(BUDGET.en.alsoApproaching()).toBe('. Also approaching: ');
    expect(BUDGET.en.pausedUntilSuffix('B')).toBe(". I've paused until B");
    expect(BUDGET.en.headsUpPrefix()).toBe('Heads up — ');
  });

  test('DENY maintainer frame', () => {
    expect(DENY.en.maintainerBase('Bash')).toBe('Auto-mode denied: Bash');
    expect(DENY.en.maintainerTail()).toBe('. Session continues; the agent will try another way. If it was intended, tell the agent in chat.');
    expect(DENY['pt-PT'].maintainerTail()).toBe('. A sessão continua; o agente vai tentar outra via. Se foi intencional, diga-o ao agente na conversa.');
  });

  test('MINT openLink / failed / signedIn (ackPrompt deliberately excluded)', () => {
    expect(MINT.en.openLink('URL')).toBe('Open this link to sign in, then send me the code it gives you:\nURL');
    expect(MINT.en.failed()).toBe("That sign-in didn't complete. Nothing changed — we can try again whenever you're ready.");
    expect(MINT.en.signedIn('5 July 2026')).toBe(
      "You're signed back in. Nothing else to do — the next renewal is due 5 July 2026, and I'll ask you then.",
    );
  });

  test('WATCHDOG lifecycle messages', () => {
    expect(WATCHDOG.en.restart('08:30', 'it had frozen', true)).toBe(
      'Attempting to restart your agent at 08:30: it had frozen. Its conversation is restored where possible, but work in flight since the last save may not have carried over, so it will re-check its work before continuing.',
    );
    expect(WATCHDOG.en.restartCauseNotRunning()).toBe("it wasn't running");
    expect(WATCHDOG.en.restartCauseFrozen()).toBe('it had frozen');
    expect(WATCHDOG.en.wedge('08:30')).toBe(
      "Your agent hasn't responded in a while — checking on it now (08:30). If it has to be restarted, work in flight may be lost.",
    );
    expect(WATCHDOG.en.pauseUntilResume('X')).toBe('Your agent is paused (X) until you resume it.');
    expect(WATCHDOG.en.pauseUntilDate('X', 'B')).toBe('Your agent is paused (X) until B.');
    expect(WATCHDOG.en.stallQuestion('08:30')).toBe(
      "Your agent is waiting on a question it can't ask over chat — open the terminal or Claude app to answer (08:30).",
    );
    expect(WATCHDOG.en.stallPermission('08:30')).toBe(
      'The agent asked for permission to continue and is waiting for an answer (08:30). It will pick up where it left off once someone approves.',
    );
    expect(WATCHDOG['pt-PT'].stallPermission('08:30')).toBe(
      'O agente pediu autorização para continuar e está à espera de resposta (08:30). Retoma onde parou assim que alguém aprovar.',
    );
    expect(WATCHDOG.en.lapsedLogin('08:30', 'FIX')).toBe(
      "Your Claude login has expired, so your agent can't do any work until you sign in again (08:30). FIX",
    );
  });

  // The lapsed-login fix lines are the one place a channel message has to name a
  // command: the sign-in happens on the machine the hermit runs on, so there is no
  // chat-side alternative to point at. Pinned in both locales because a translation
  // that drops or garbles the command leaves the operator with no way back in.
  test('WATCHDOG lapsed-login fix lines carry a runnable command in both locales', () => {
    expect(WATCHDOG.en.lapsedLoginFixDocker()).toContain('hermitd docker login');
    expect(WATCHDOG.en.lapsedLoginFixHost()).toContain('/login');
    expect(WATCHDOG['pt-PT'].lapsedLoginFixDocker()).toContain('hermitd docker login');
    expect(WATCHDOG['pt-PT'].lapsedLoginFixHost()).toContain('/login');
    expect(WATCHDOG['pt-PT'].lapsedLogin('08:30', 'FIX')).toContain('(08:30). FIX');
  });
});
