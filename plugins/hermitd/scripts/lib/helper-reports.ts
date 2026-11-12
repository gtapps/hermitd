import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { HELPER_OWNER, mutateTask, threadRecords, type Task, type TaskFlags } from './tasks';
import { readSettledConfig } from './config-read';
import { sendToOwnedChat, sendOperatorNotice, type SendResult } from './channel-send';
import { classifyChat } from './channel-chats';
import { safeForLLM } from './sanitize';
import { loadMessages } from './messages';

const REFUSALS = new Set(['not_owner', 'closed', 'empty', 'report_too_long', 'report_outside_state', 'consent_required', 'not_found']);
export type ReportDelivery = 'sent' | 'partial' | 'failed' | 'relay' | 'no_channel';

/** Immutable report body and binding, both confined to the pinned state root. */
export function storeHelperReport(
  dir: string, text: string, binding: { task: string | null; author: string },
  createId = () => randomBytes(5).toString('hex'),
): string {
  const root = fs.realpathSync(dir);
  const reports = path.join(root, 'helper-reports');
  fs.mkdirSync(reports, { recursive: true });
  if (fs.lstatSync(reports).isSymbolicLink() || !fs.realpathSync(reports).startsWith(root + path.sep)) throw new Error('report_outside_state');
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = createId();
    if (!/^[a-z0-9]{10}$/.test(id)) throw new Error('invalid_report_id');
    const file = path.join(reports, `${id}.md`);
    let fd: number;
    try { fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o444); }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('report_outside_state');
      continue;
    }
    try {
      if (!fs.realpathSync(file).startsWith(reports + path.sep)) throw new Error('report_outside_state');
      fs.writeFileSync(path.join(reports, `${id}.json`), JSON.stringify(binding) + '\n', { flag: 'wx', mode: 0o444 });
      fs.writeFileSync(fd, text);
      return id;
    } catch (error) {
      fs.unlinkSync(file);
      fs.rmSync(path.join(reports, `${id}.json`), { force: true });
      throw error;
    } finally { fs.closeSync(fd); }
  }
  throw new Error('report_id_exhausted');
}

function deliveryOf(result: SendResult | undefined): ReportDelivery {
  if (result?.ok) return 'sent';
  if (result?.partial) return 'partial';
  if (result?.error === 'no_send_path') return 'relay';
  if (!result || result.error === 'no_reachable_channel') return 'no_channel';
  return 'failed';
}

export async function submitHelperReport(dir: string, id: string | undefined, flags: TaskFlags, text: string): Promise<unknown> {
  const author = flags.as;
  const noTask = flags['no-task'] === true;
  if (typeof author !== 'string' || !(author === 'worker' || HELPER_OWNER.test(author))) throw new Error('invalid_author');
  if (noTask ? id !== undefined || author === 'worker' : id === undefined) throw new Error('invalid_arguments');
  const kind = flags.kind ?? (noTask ? 'note' : undefined);
  if (!['result', 'needs-input', 'note'].includes(String(kind))) throw new Error('invalid_kind');
  try {
    if (!text.trim()) throw new Error('empty');
    if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('report_too_long');
    let report = '';
    let recorded: Task | undefined;
    const store = (record?: Task) => {
      report = storeHelperReport(dir, text, { task: id ?? null, author });
      recorded = record;
    };
    if (noTask) store();
    else {
      const tag = author === 'worker' ? '[worker]' : `[guest:${author.slice('helper:'.length)}]`;
      // Owner validation and storage run inside mutateTask's writer lock. The
      // original transitions remain the sole owners of result/consent logic.
      const mutation: { verb: string; flags: TaskFlags; input: string } = {
        result: { verb: 'block', flags: { 'result-stdin': true, actor: tag }, input: text },
        'needs-input': { verb: 'block', flags: { 'status-line': text.trim().split(/\r?\n/, 1)[0], next: 'Requester response', actor: tag }, input: text },
        note: { verb: 'note', flags: { actor: tag }, input: `${tag} ${text}` },
      }[kind as 'result' | 'needs-input' | 'note'];
      mutateTask(dir, mutation.verb, id, mutation.flags, mutation.input, false, null, {
        author,
        store,
      });
    }
    const config = readSettledConfig(dir);
    const notice = loadMessages(dir, config.language).t('task_report_truncated');
    let delivery: ReportDelivery;
    if (noTask) {
      const sent = await sendOperatorNotice(dir, { client: text, relay: true, discordCapNotice: notice });
      delivery = sent.relay ? 'relay' : deliveryOf(sent.client);
    } else if (!recorded?.conversation) delivery = 'no_channel';
    else {
      const [source, destination] = recorded.conversation.split(':');
      const [chatId, thread] = destination.split('~');
      const label = threadRecords(dir).filter(task => task.conversation === recorded!.conversation).length >= 2
        && await classifyChat(dir, config, source, chatId, thread) === 'shared'
        ? `${recorded.handle} · ${safeForLLM(recorded.title).slice(0, 60)}: ` : '';
      delivery = deliveryOf(await sendToOwnedChat(dir, `${source}:${chatId}`, label + text, { config, thread, discordCapNotice: notice }));
    }
    return { report, task: id ?? null, recorded: !noTask, result_rev: recorded?.result_rev ?? null, delivery };
  } catch (error) {
    if (error instanceof Error && REFUSALS.has(error.message)) return { status: 'refused', reason: error.message };
    throw error;
  }
}
