// A complete European Portuguese state/messages.json, as a language-set skill
// would write it, for tests that check a translated install end to end.

import fs from 'node:fs';
import path from 'node:path';
import { EN, enHash, buildMessages, messagesPath, type MessageKey } from '../../scripts/lib/messages';

const PT_TEXT: Record<MessageKey, string> = {
  pause_reason_budget: 'um limite de orçamento',
  pause_reason_watchdog: 'o watchdog',
  pause_reason_request: 'o seu pedido',
  status_paused_until_resume: 'Em pausa ({label}) até que a retome.',
  status_paused_until_date: 'Em pausa ({label}) até {boundary}.',
  status_working_on: 'A trabalhar em {task}.',
  status_working: 'A trabalhar.',
  status_idle: 'Parado.',
  status_one_approval: '1 aprovação pendente (responda "{id} sim/não").',
  status_n_approvals: '{n} aprovações pendentes.',
  status_next_routine: 'Próxima rotina: {hh}:{mm} ({id}).',
  status_all_quiet: 'Tudo calmo — nada em curso, nada à espera.',
  spend_label_daily: 'Hoje',
  spend_label_weekly: 'Esta semana',
  spend_label_monthly: 'Este mês',
  spend_cap_status: '{label}: {spend} de um limite de {cap}.',
  budget_period_daily: 'de hoje',
  budget_period_weekly: 'desta semana',
  budget_period_monthly: 'deste mês',
  budget_clause: 'o gasto {period} é de ${spend} do seu limite de ${cap} ({pct}%)',
  budget_cap_reached_prefix: 'Limite de orçamento atingido — ',
  budget_also_approaching: '. Também perto do limite: ',
  budget_paused_until_suffix: '. Fiz uma pausa até {boundary}',
  budget_heads_up_prefix: 'Atenção — ',
  budget_client_paused: 'Fiz uma pausa no trabalho até {boundary} para respeitar o plano definido. Retomo nessa altura.',
  deny_base: 'Negado em modo automático: {tool}',
  deny_suppressed: ' (+{count} nos 30 min anteriores)',
  deny_tail: '. A sessão continua; o agente vai tentar outra via. Se foi intencional, diga-o ao agente na conversa.',
  mint_ack_prompt:
    'O início de sessão Claude do seu agente expirou e ele não pode trabalhar até ser renovado. ' +
    "Responda '{keyword}' na conversa onde normalmente fala comigo e envio-lhe um link de início de sessão de utilização única.",
  mint_open_link: 'Abra este link para iniciar sessão e envie-me o código que ele lhe der:\n{url}',
  mint_failed: 'Esse início de sessão não foi concluído. Nada mudou — podemos tentar de novo quando quiser.',
  mint_signed_in: 'Sessão renovada. Não precisa de fazer mais nada — a próxima renovação será {date} e eu aviso-o nessa altura.',
  mint_signed_in_undated: 'Sessão renovada. Não precisa de fazer mais nada — eu aviso-o quando a próxima renovação for necessária.',
  mint_date_unknown: 'daqui a cerca de um ano',
  watchdog_restart_resumed: 'A tentar reiniciar o seu agente às {time}: {cause}. A conversa é retomada sempre que possível, mas o trabalho em curso desde o último registo pode não ter sido mantido, por isso o agente volta a verificar o seu trabalho antes de continuar.',
  watchdog_restart_fresh: 'A tentar reiniciar o seu agente às {time}: {cause}. Começa uma conversa nova, por isso o trabalho em curso desde o último registo perde-se e o agente retoma a partir do trabalho guardado.',
  watchdog_cause_not_running: 'não estava a correr',
  watchdog_cause_frozen: 'tinha bloqueado',
  watchdog_cause_upgrade: 'precisa de concluir uma atualização',
  watchdog_cause_requested: 'foi pedido um reinício',
  watchdog_wedge: 'O seu agente não responde há algum tempo — estou a verificá-lo agora ({time}). Se tiver de ser reiniciado, o trabalho em curso pode perder-se.',
  watchdog_wedge_recovered: 'O seu agente já está a responder, não precisa de fazer nada ({time}).',
  watchdog_paused_until_resume: 'O seu agente está em pausa ({label}) até que a retome.',
  watchdog_paused_until_date: 'O seu agente está em pausa ({label}) até {boundary}.',
  watchdog_stall_question: 'O seu agente está à espera de uma pergunta que não pode fazer pelo chat — abra o terminal ou a app Claude para responder ({time}).',
  watchdog_stall_permission: 'O agente pediu autorização para continuar e está à espera de resposta ({time}). Retoma onde parou assim que alguém aprovar.',
  watchdog_session_wedged: 'O seu agente deixou de executar o trabalho agendado — algo no ecrã está a bloqueá-lo. Abra o terminal ou a app Claude e resolva o que está à espera ({time}).',
  watchdog_orphan: 'A sessão do seu agente terminou mas pode haver um processo ainda a correr ({time}). Se continuar a responder, pare-o no terminal: corra {command} e faça kill desse PID.',
  watchdog_lapsed_login: 'A sua sessão Claude expirou, por isso o seu agente não consegue trabalhar até voltar a autenticar-se ({time}). {fix}',
  watchdog_lapsed_login_fix_docker: 'Isto tem de ser feito na máquina onde ele corre: {login} e depois {restart}.',
  watchdog_lapsed_login_fix_host: 'Isto tem de ser feito na máquina onde ele corre: corra {claude} na pasta do projeto, escreva {login} e reinicie-o com {stop} e {start}.',
  watchdog_env_auth_failure: 'A credencial de API do seu agente está a ser rejeitada, por isso não consegue trabalhar até essa chave voltar a ser válida ({time}). Não é uma autenticação que possa renovar pelo chat — verifique a chave onde a definiu: pode ter sido revogada ou rodada, ou a conta pode estar sem crédito. Deixei a sessão como está em vez de a reiniciar, porque um reinício perderia a chave por completo.',
  watchdog_usage_limit: 'O seu agente atingiu o limite de utilização da Claude por agora ({time}). Vai retomar sozinho às {reset}.',
  watchdog_usage_limit_no_reset: 'O seu agente atingiu o limite de utilização da Claude por agora ({time}). Vai retomar sozinho quando o limite renovar.',
  watchdog_api_unavailable: 'O seu agente está afetado por uma interrupção temporária do serviço da Claude ({time}). Vai retomar sozinho. {url}',
  shutdown_in_progress: 'A desligar — volto assim que o reinício terminar.',
  owned_chat_thread_unreachable: '(o tópico original já não está acessível)',
};

/** The file a language-set skill writes for `language: "pt"`. */
export function ptMessagesFile(language = 'pt') {
  return {
    language,
    locale: 'pt-PT',
    strings: Object.fromEntries((Object.keys(EN) as MessageKey[]).map((k) => [k, { text: PT_TEXT[k], en_hash: enHash(k) }])),
    overrides: {},
  };
}

export const PT = buildMessages(ptMessagesFile(), 'pt');

/** Writes the Portuguese messages file into a hermit dir (`.hermit`). */
export function writePtMessages(hermitDir: string, language = 'pt'): void {
  fs.mkdirSync(path.dirname(messagesPath(hermitDir)), { recursive: true });
  fs.writeFileSync(messagesPath(hermitDir), JSON.stringify(ptMessagesFile(language), null, 2));
}
