import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { HELPER_OWNER, mutateTask, settleReportDelivery, threadRecords, type Task, type TaskFlags } from './tasks';
import { readSettledConfig } from './config-read';
import { sendToOwnedChat, type SendResult } from './channel-send';
import { classifyChat } from './channel-chats';
import { clip, safeForLLM } from './sanitize';
import { loadMessages } from './messages';

const REFUSALS = new Set(['not_owner', 'closed', 'empty', 'report_too_long', 'report_outside_state', 'consent_required', 'not_found']);
type ReportKind = 'result' | 'needs-input' | 'note';
export type ReportDelivery = 'sent' | 'partial' | 'failed' | 'relay' | 'no_channel';

const numberedLine = /^\s*\d+[.)]\s+(.*)$/;
export function hasNumberedReportLine(text: string): boolean {
  return text.split(/\r?\n/).some(line => numberedLine.test(line));
}

export function reportDecisionTitles(text: string): string[] {
  const lines = text.trimStart().split(/\r?\n/).slice(1);
  const start = lines.findIndex(line => line.trim());
  if (start === -1) return [];
  const titles: string[] = [];
  for (const line of lines.slice(start, start + 5)) {
    const item = numberedLine.exec(line);
    if (!item) break;
    titles.push(item[1].trim());
  }
  return titles;
}

export function reportSummary(dir: string, reportId: string | null) {
  const empty = { report_verdict: null, report_decisions: [] };
  if (!reportId || !/^[a-z0-9]{10}$/.test(reportId)) return empty;
  const reports = path.join(dir, 'helper-reports');
  try {
    if (fs.lstatSync(reports).isSymbolicLink()) return empty;
    const fd = fs.openSync(path.join(reports, reportId + '.md'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 64 * 1024) return empty;
      const text = fs.readFileSync(fd, 'utf8');
      const verdict = text.trimStart().split(/\r?\n/, 1)[0].trim();
      const bounded = (line: string) => clip(safeForLLM(line), 200);
      return { report_verdict: verdict ? bounded(verdict) : null, report_decisions: reportDecisionTitles(text).map(bounded) };
    } finally { fs.closeSync(fd); }
  } catch { return empty; }
}

/** Immutable report files confined to the pinned state root. */
export function storeHelperReport(
  dir: string, text: string, binding: { task: string | null; author: string },
  createId = () => randomBytes(5).toString('hex'),
  procedure = '',
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
    const created = [file];
    try {
      if (!fs.realpathSync(file).startsWith(reports + path.sep)) throw new Error('report_outside_state');
      const write = (suffix: string, contents: string) => {
        const target = path.join(reports, id + suffix);
        const output = fs.openSync(target, 'wx', 0o444);
        created.push(target);
        try { fs.writeFileSync(output, contents); }
        finally { fs.closeSync(output); }
      };
      write('.json', JSON.stringify(binding) + '\n');
      if (procedure) write('.procedure.md', procedure);
      fs.writeFileSync(fd, text);
      return id;
    } catch (error) {
      for (const target of created) fs.unlinkSync(target);
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
  if (typeof author !== 'string' || !(author === 'worker' || HELPER_OWNER.test(author))) throw new Error('invalid_author');
  if (id === undefined) throw new Error('invalid_arguments');
  if (flags.kind !== 'result' && flags.kind !== 'needs-input' && flags.kind !== 'note') throw new Error('invalid_kind');
  const kind: ReportKind = flags.kind;
  try {
    if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('report_too_long');
    const delimiter = /^[^\S\r\n]*--- procedure ---[^\S\r\n]*\r?$/m.exec(text);
    const procedure = delimiter ? text.slice(delimiter.index + delimiter[0].length).trim() : '';
    if (delimiter) text = text.slice(0, delimiter.index);
    if (!text.trim()) throw new Error('empty');

    let report = '';
    let recorded!: Task;
    const tag = author === 'worker' ? '[worker]' : `[guest:${author.slice('helper:'.length)}]`;
    const mutation: { verb: string; flags: TaskFlags; input: string } = {
      result: { verb: 'block', flags: { 'result-stdin': true, actor: tag }, input: text },
      'needs-input': { verb: 'block', flags: { 'status-line': text.trim().split(/\r?\n/, 1)[0], next: 'Requester response', actor: tag }, input: text },
      note: { verb: 'note', flags: { actor: tag }, input: `${tag} ${text}` },
    }[kind];
    mutateTask(dir, mutation.verb, id, mutation.flags, mutation.input, false, null, {
      author,
      autoClose: kind === 'result' && !hasNumberedReportLine(text),
      store(record) {
        report = storeHelperReport(dir, text, { task: id, author }, undefined, procedure);
        recorded = record;
        record.report_id = report;
        record.report_kind = kind;
        record.delivery = record.conversation ? 'pending' : 'no_channel';
      },
    });

    let delivery: ReportDelivery = 'no_channel';
    if (recorded.conversation) {
      const config = readSettledConfig(dir);
      const notice = loadMessages(dir, config.language).t('task_report_truncated');
      const [source, destination] = recorded.conversation.split(':');
      const [chatId, thread] = destination.split('~');
      const label = threadRecords(dir).filter(task => task.conversation === recorded.conversation).length >= 2
        && await classifyChat(dir, config, source, chatId, thread) === 'shared'
        ? `${recorded.handle} · ${clip(safeForLLM(recorded.title), 60)}: ` : '';
      delivery = deliveryOf(await sendToOwnedChat(dir, `${source}:${chatId}`, label + text, { config, thread, discordCapNotice: notice }));
      settleReportDelivery(dir, id, report, delivery);
    }
    return { report, task: id, recorded: true, result_rev: recorded.result_rev, delivery };
  } catch (error) {
    if (error instanceof Error && REFUSALS.has(error.message)) return { status: 'refused', reason: error.message };
    throw error;
  }
}
