// Operator-facing message catalog for script-owned channel sends.
//
// Every deterministic (non-model) sender composes its operator prose here so a
// hermit configured with `language: "pt"` speaks Portuguese on the channel, not
// just on the model path. No i18n framework: a flat set of per-domain typed
// tables, `en` as the guaranteed fallback, one added object per new language.
//
// The `en` bodies are byte-for-byte the strings the senders used before this
// module existed (verified by tests/localization-regression.test.ts), except for
// the mint ack prompt (unified to one destination-agnostic wording), which is
// called out in the CHANGELOG.

export type Locale = 'en' | 'pt-PT';
export type Localized<T> = Record<Locale, T>;

/**
 * Map the free-form `config.language` field to a supported locale. Tolerant by
 * design — the field is documented as free text ("Portuguese", "pt-BR", "pt_PT"
 * all occur in the wild), so any Portuguese signifier resolves to European
 * Portuguese and everything else (including null/invalid) falls back to English.
 */
export function resolveLocale(language: unknown): Locale {
  if (typeof language !== 'string') return 'en';
  const n = language.trim().toLowerCase().replace(/_/g, '-');
  if (n === 'pt' || n.startsWith('pt-') || n === 'portuguese' || n === 'português' || n === 'portugues') {
    return 'pt-PT';
  }
  return 'en';
}

// ---------- dates ----------

const PT_MONTHS = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

export const dates = {
  /**
   * Long friendly date for the mint success line. `en` reproduces the exact
   * `toLocaleDateString('en-GB', …)` call the mint flow used; `pt-PT` renders
   * from a static month table (never `toLocaleDateString('pt-PT')`, whose output
   * depends on the Bun build's ICU data). Invalid input → the "about a year"
   * fallback in the caller's locale.
   */
  friendlyDate(locale: Locale, iso: string): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return locale === 'pt-PT' ? 'daqui a cerca de um ano' : 'in about a year';
    if (locale === 'pt-PT') return `${d.getDate()} de ${PT_MONTHS[d.getMonth()]} de ${d.getFullYear()}`;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  },
};

// ---------- pause reason labels (shared: status responder + watchdog) ----------

export interface PauseMessages {
  reasonLabel(reason: string): string;
}

export const PAUSE: Localized<PauseMessages> = {
  en: {
    reasonLabel: (reason) =>
      reason === 'budget' ? 'a budget cap' : reason === 'watchdog' ? 'the watchdog' : 'your request',
  },
  'pt-PT': {
    reasonLabel: (reason) =>
      reason === 'budget' ? 'um limite de orçamento' : reason === 'watchdog' ? 'o watchdog' : 'o seu pedido',
  },
};

// ---------- status responder ----------

export interface StatusMessages {
  pausedUntilResume(label: string): string;
  pausedUntilDate(label: string, boundary: string): string;
  workingOn(task: string): string;
  redactedWorking(): string;
  redactedIdle(): string;
  oneApproval(id: string): string;
  nApprovals(n: number): string;
  nextRoutine(hh: string, mm: string, id: string): string;
  allQuiet(): string;
}

export const STATUS: Localized<StatusMessages> = {
  en: {
    pausedUntilResume: (label) => `Paused (${label}) until you resume it.`,
    pausedUntilDate: (label, boundary) => `Paused (${label}) until ${boundary}.`,
    workingOn: (task) => `Working on ${task}.`,
    redactedWorking: () => 'Working.',
    redactedIdle: () => 'Idle.',
    oneApproval: (id) => `1 approval waiting (reply "${id} yes/no").`,
    nApprovals: (n) => `${n} approvals waiting.`,
    nextRoutine: (hh, mm, id) => `Next routine: ${hh}:${mm} (${id}).`,
    allQuiet: () => 'All quiet — nothing in progress, nothing waiting.',
  },
  'pt-PT': {
    pausedUntilResume: (label) => `Em pausa (${label}) até que a retome.`,
    pausedUntilDate: (label, boundary) => `Em pausa (${label}) até ${boundary}.`,
    workingOn: (task) => `A trabalhar em ${task}.`,
    redactedWorking: () => 'A trabalhar.',
    redactedIdle: () => 'Parado.',
    oneApproval: (id) => `1 aprovação pendente (responda "${id} yes/no").`,
    nApprovals: (n) => `${n} aprovações pendentes.`,
    nextRoutine: (hh, mm, id) => `Próxima rotina: ${hh}:${mm} (${id}).`,
    allQuiet: () => 'Tudo calmo — nada em curso, nada à espera.',
  },
};

// ---------- spend cap status line (spend-status.ts) ----------

export interface SpendMessages {
  capLabel(period: 'daily' | 'weekly' | 'monthly'): string;
  capStatus(label: string, spend: string, cap: string): string;
}

export const SPEND: Localized<SpendMessages> = {
  en: {
    capLabel: (period) => (period === 'daily' ? 'Today' : period === 'weekly' ? 'This week' : 'This month'),
    capStatus: (label, spend, cap) => `${label}: ${spend} of ${cap} cap.`,
  },
  'pt-PT': {
    capLabel: (period) => (period === 'daily' ? 'Hoje' : period === 'weekly' ? 'Esta semana' : 'Este mês'),
    capStatus: (label, spend, cap) => `${label}: ${spend} de um limite de ${cap}.`,
  },
};

// ---------- budget push (cost-tracker.ts) ----------

export interface BudgetMessages {
  periodPossessive(period: string): string;
  clause(possessive: string, spend: number, cap: number, ratioPct: number): string;
  capReachedPrefix(): string;
  alsoApproaching(): string;
  pausedUntilSuffix(boundary: string): string;
  headsUpPrefix(): string;
  clientPaused(boundary: string): string;
}

export const BUDGET: Localized<BudgetMessages> = {
  en: {
    periodPossessive: (period) =>
      ({ daily: "today's", weekly: "this week's", monthly: "this month's" } as Record<string, string>)[period] ?? period,
    clause: (possessive, spend, cap, ratioPct) =>
      `${possessive} spend is $${spend.toFixed(2)} of your $${cap.toFixed(2)} cap (${ratioPct}%)`,
    capReachedPrefix: () => 'Budget cap reached — ',
    alsoApproaching: () => '. Also approaching: ',
    pausedUntilSuffix: (boundary) => `. I've paused until ${boundary}`,
    headsUpPrefix: () => 'Heads up — ',
    clientPaused: (boundary) =>
      `I've paused work until ${boundary} to stay within the plan you set. I'll pick it back up then.`,
  },
  'pt-PT': {
    periodPossessive: (period) =>
      ({ daily: 'de hoje', weekly: 'desta semana', monthly: 'deste mês' } as Record<string, string>)[period] ?? period,
    clause: (possessive, spend, cap, ratioPct) =>
      `o gasto ${possessive} é de $${spend.toFixed(2)} do seu limite de $${cap.toFixed(2)} (${ratioPct}%)`,
    capReachedPrefix: () => 'Limite de orçamento atingido — ',
    alsoApproaching: () => '. Também perto do limite: ',
    pausedUntilSuffix: (boundary) => `. Fiz uma pausa até ${boundary}`,
    headsUpPrefix: () => 'Atenção — ',
    clientPaused: (boundary) =>
      `Fiz uma pausa no trabalho até ${boundary} para respeitar o plano definido. Retomo nessa altura.`,
  },
};

// ---------- heartbeat tick (lib/heartbeat/tick.ts) ----------

export interface HeartbeatMessages {
  waitingTimeout(timeout: string): string;
  queuedTask(task: string | null): string;
}

export const HEARTBEAT: Localized<HeartbeatMessages> = {
  en: {
    waitingTimeout: (timeout) => `Waiting timeout reached after ${timeout} — session returning to idle.`,
    queuedTask: (task) =>
      `A task is queued and ready to start${task ? `: ${task}` : ''}. Tell me to go ahead and I'll pick it up.`,
  },
  'pt-PT': {
    waitingTimeout: (timeout) => `Tempo de espera esgotado ao fim de ${timeout} — a sessão volta a ficar inativa.`,
    queuedTask: (task) =>
      `Há uma tarefa em fila pronta a começar${task ? `: ${task}` : ''}. Diga-me para avançar e eu trato dela.`,
  },
};

// ---------- auto-mode denial (permission-denied-notify.ts) ----------
// `maintainer*` provides the technical frame for the operator who owns the
// maintainer channel / state/watchdog-events.jsonl. `maintainerSuppressed` reports the
// burst size the previous dedup window absorbed — one blocked call reads very
// differently from twelve, and the count is the only carrier of that.

export interface DenyMessages {
  maintainerBase(toolName: string): string;
  maintainerSuppressed(count: number): string;
  maintainerTail(): string;
}

export const DENY: Localized<DenyMessages> = {
  en: {
    maintainerBase: (toolName) => `Auto-mode denied: ${toolName}`,
    maintainerSuppressed: (count) => ` (+${count} more in the previous 30 min)`,
    maintainerTail: () => '. Session continues. If intended: /hermit-settings or handle at the pane.',
  },
  'pt-PT': {
    maintainerBase: (toolName) => `Negado em modo automático: ${toolName}`,
    maintainerSuppressed: (count) => ` (+${count} nos 30 min anteriores)`,
    maintainerTail: () => '. A sessão continua. Se for intencional: /hermit-settings ou trate no terminal.',
  },
};

// ---------- token mint (setup-token-mint.ts) ----------
// `ackPrompt` is the unified destination-agnostic wording (replaces the old
// "when you're at a browser" copy). The literal `reauth` keyword is preserved in
// both locales — `findAck` matches /\breauth\b/i and stays untouched.

export interface MintMessages {
  ackPrompt(): string;
  openLink(url: string): string;
  failed(): string;
  signedIn(dueDate: string): string;
  /** Same confirmation, for a credential that carries no renewal date to quote. */
  signedInUndated(): string;
}

export const MINT: Localized<MintMessages> = {
  en: {
    ackPrompt: () =>
      "Your agent's Claude login has expired, so it can't work until it's renewed. " +
      "Reply 'reauth' in the chat where you normally talk to me and I'll send you a one-time sign-in link.",
    openLink: (url) => `Open this link to sign in, then send me the code it gives you:\n${url}`,
    failed: () => "That sign-in didn't complete. Nothing changed — we can try again whenever you're ready.",
    signedIn: (dueDate) =>
      `You're signed back in. Nothing else to do — the next renewal is due ${dueDate}, and I'll ask you then.`,
    signedInUndated: () =>
      "You're signed back in. Nothing else to do — I'll ask you again when the next renewal is due.",
  },
  'pt-PT': {
    ackPrompt: () =>
      "O início de sessão Claude do seu agente expirou e ele não pode trabalhar até ser renovado. " +
      "Responda 'reauth' na conversa onde normalmente fala comigo e envio-lhe um link de início de sessão de utilização única.",
    openLink: (url) => `Abra este link para iniciar sessão e envie-me o código que ele lhe der:\n${url}`,
    failed: () => 'Esse início de sessão não foi concluído. Nada mudou — podemos tentar de novo quando quiser.',
    signedIn: (dueDate) =>
      `Sessão renovada. Não precisa de fazer mais nada — a próxima renovação será ${dueDate} e eu aviso-o nessa altura.`,
    signedInUndated: () =>
      'Sessão renovada. Não precisa de fazer mais nada — eu aviso-o quando a próxima renovação for necessária.',
  },
};

// ---------- watchdog lifecycle pushes (hermitd-watchdog.ts) ----------

export interface WatchdogMessages {
  restart(hhmm: string, cause: string, resumed: boolean): string;
  restartCauseNotRunning(): string;
  restartCauseFrozen(): string;
  restartCauseUpgrade(): string;
  wedge(hhmm: string): string;
  wedgeRecovered(hhmm: string): string;
  pauseUntilResume(label: string): string;
  pauseUntilDate(label: string, boundary: string): string;
  stallQuestion(hhmm: string): string;
  sessionWedged(hhmm: string): string;
  orphan(hhmm: string): string;
  lapsedLogin(hhmm: string, howToFix: string): string;
  lapsedLoginFixDocker(): string;
  lapsedLoginFixHost(): string;
  envAuthFailure(hhmm: string): string;
  usageLimit(hhmm: string, resetAt: string): string;
  usageLimitNoReset(hhmm: string): string;
  apiUnavailable(hhmm: string): string;
}

export const WATCHDOG: Localized<WatchdogMessages> = {
  en: {
    restart: (hhmm, cause, resumed) => resumed
      ? `Attempting to restart your agent at ${hhmm}: ${cause}. Its conversation is restored where possible, but work in flight since the last save may not have carried over, so it will re-check its work before continuing.`
      : `Attempting to restart your agent at ${hhmm}: ${cause}. It starts a fresh conversation, so work in flight since the last save is lost and it picks up from its saved work.`,
    restartCauseNotRunning: () => "it wasn't running",
    restartCauseFrozen: () => 'it had frozen',
    restartCauseUpgrade: () => 'it needs to finish an upgrade',
    wedge: (hhmm) => `Your agent hasn't responded in a while — checking on it now (${hhmm}). If it has to be restarted, work in flight may be lost.`,
    wedgeRecovered: (hhmm) => `Your agent is responding again, nothing to do (${hhmm}).`,
    pauseUntilResume: (label) => `Your agent is paused (${label}) until you resume it.`,
    pauseUntilDate: (label, boundary) => `Your agent is paused (${label}) until ${boundary}.`,
    stallQuestion: (hhmm) =>
      `Your agent is waiting on a question it can't ask over chat — open the terminal or Claude app to answer (${hhmm}).`,
    sessionWedged: (hhmm) =>
      `Your agent has stopped picking up its scheduled work — something on screen is holding it. Open the terminal or Claude app and clear whatever is waiting there (${hhmm}).`,
    orphan: (hhmm) =>
      `Your agent's session ended but a process may still be running (${hhmm}). If it keeps replying, stop it from the terminal: run \`pgrep -af "claude --channels"\` and kill that PID.`,
    lapsedLogin: (hhmm, howToFix) =>
      `Your Claude login has expired, so your agent can't do any work until you sign in again (${hhmm}). ${howToFix}`,
    lapsedLoginFixDocker: () =>
      'This one needs the machine it runs on: `hermitd docker login`, then `hermitd restart`.',
    lapsedLoginFixHost: () =>
      'This one needs the machine it runs on: run `claude` in its project folder, type `/login`, then restart it with `hermitd stop` and `hermitd start`.',
    envAuthFailure: (hhmm) =>
      `Your agent's API credential is being rejected, so it can't do any work until that key is valid again (${hhmm}). This isn't a sign-in you can renew from chat — check the key where you set it: it may have been revoked or rotated, or the account may be out of credit. I've left the session alone rather than restarting it, because a restart would lose the key entirely.`,
    usageLimit: (hhmm, resetAt) =>
      `Your agent has reached Claude's usage limit for now (${hhmm}). It will resume on its own at ${resetAt}.`,
    usageLimitNoReset: (hhmm) =>
      `Your agent has reached Claude's usage limit for now (${hhmm}). It will resume on its own once the limit resets.`,
    apiUnavailable: (hhmm) =>
      `Your agent is affected by a temporary Claude service outage (${hhmm}). It will resume on its own. https://status.claude.com`,
  },
  'pt-PT': {
    restart: (hhmm, cause, resumed) => resumed
      ? `A tentar reiniciar o seu agente às ${hhmm}: ${cause}. A conversa é retomada sempre que possível, mas o trabalho em curso desde o último registo pode não ter sido mantido, por isso o agente volta a verificar o seu trabalho antes de continuar.`
      : `A tentar reiniciar o seu agente às ${hhmm}: ${cause}. Começa uma conversa nova, por isso o trabalho em curso desde o último registo perde-se e o agente retoma a partir do trabalho guardado.`,
    restartCauseNotRunning: () => 'não estava a correr',
    restartCauseFrozen: () => 'tinha bloqueado',
    restartCauseUpgrade: () => 'precisa de concluir uma atualização',
    wedge: (hhmm) => `O seu agente não responde há algum tempo — estou a verificá-lo agora (${hhmm}). Se tiver de ser reiniciado, o trabalho em curso pode perder-se.`,
    wedgeRecovered: (hhmm) => `O seu agente já está a responder, não precisa de fazer nada (${hhmm}).`,
    pauseUntilResume: (label) => `O seu agente está em pausa (${label}) até que a retome.`,
    pauseUntilDate: (label, boundary) => `O seu agente está em pausa (${label}) até ${boundary}.`,
    stallQuestion: (hhmm) =>
      `O seu agente está à espera de uma pergunta que não pode fazer pelo chat — abra o terminal ou a app Claude para responder (${hhmm}).`,
    sessionWedged: (hhmm) =>
      `O seu agente deixou de executar o trabalho agendado — algo no ecrã está a bloqueá-lo. Abra o terminal ou a app Claude e resolva o que está à espera (${hhmm}).`,
    orphan: (hhmm) =>
      `A sessão do seu agente terminou mas pode haver um processo ainda a correr (${hhmm}). Se continuar a responder, pare-o no terminal: corra \`pgrep -af "claude --channels"\` e faça kill desse PID.`,
    lapsedLogin: (hhmm, howToFix) =>
      `A sua sessão Claude expirou, por isso o seu agente não consegue trabalhar até voltar a autenticar-se (${hhmm}). ${howToFix}`,
    lapsedLoginFixDocker: () =>
      'Isto tem de ser feito na máquina onde ele corre: `hermitd docker login` e depois `hermitd restart`.',
    lapsedLoginFixHost: () =>
      'Isto tem de ser feito na máquina onde ele corre: corra `claude` na pasta do projeto, escreva `/login` e reinicie-o com `hermitd stop` e `hermitd start`.',
    envAuthFailure: (hhmm) =>
      `A credencial de API do seu agente está a ser rejeitada, por isso não consegue trabalhar até essa chave voltar a ser válida (${hhmm}). Não é uma autenticação que possa renovar pelo chat — verifique a chave onde a definiu: pode ter sido revogada ou rodada, ou a conta pode estar sem crédito. Deixei a sessão como está em vez de a reiniciar, porque um reinício perderia a chave por completo.`,
    usageLimit: (hhmm, resetAt) =>
      `O seu agente atingiu o limite de utilização da Claude por agora (${hhmm}). Vai retomar sozinho às ${resetAt}.`,
    usageLimitNoReset: (hhmm) =>
      `O seu agente atingiu o limite de utilização da Claude por agora (${hhmm}). Vai retomar sozinho quando o limite renovar.`,
    apiUnavailable: (hhmm) =>
      `O seu agente está afetado por uma interrupção temporária do serviço da Claude (${hhmm}). Vai retomar sozinho. https://status.claude.com`,
  },
};

// ---------- deterministic shutdown gate (lib/prompt-stages/shutdown-gate.ts) ----------

export interface ShutdownMessages {
  inProgress(): string;
}

export const SHUTDOWN: Localized<ShutdownMessages> = {
  en: {
    inProgress: () => "Shutting down — I'll be back once the restart completes.",
  },
  'pt-PT': {
    inProgress: () => 'A desligar — volto assim que o reinício terminar.',
  },
};
