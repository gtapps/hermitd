import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { HELPER_OWNER, mutateTask, settleReportDelivery, threadRecords, type Task, type TaskFlags } from './tasks';
import { readSettledConfig } from './config-read';
import { sendToOwnedChat, type SendResult } from './channel-send';
import { classifyChat } from './channel-chats';
import { channelStateDirs } from './channel-config';
import { clip, safeForLLM } from './sanitize';
import { loadMessages } from './messages';

const REFUSALS = new Set(['not_owner', 'closed', 'empty', 'report_too_long', 'report_outside_state', 'consent_required', 'not_found', 'invalid_file']);
type ReportKind = 'result' | 'needs-input' | 'note';
export type ReportDelivery = 'sent' | 'partial' | 'failed' | 'relay' | 'no_channel';

const REPORT_ID = /^[a-z0-9]{10}$/;
const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_WRONLY, O_CREAT, O_EXCL } = fs.constants;

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

function readReportFile(file: string, maxBytes: number): string | undefined {
  const fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return;
    const buffer = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!count) break;
      offset += count;
    }
    return buffer.toString('utf8', 0, offset);
  } finally { fs.closeSync(fd); }
}

export function reportSummary(dir: string, reportId: string | null) {
  const empty = { report_verdict: null, report_decisions: [] };
  if (!reportId || !REPORT_ID.test(reportId)) return empty;
  const reports = path.join(dir, 'helper-reports');
  try {
    if (fs.lstatSync(reports).isSymbolicLink()) return empty;
    const text = readReportFile(path.join(reports, reportId + '.md'), 64 * 1024);
    if (text === undefined) return empty;
    const verdict = text.trimStart().split(/\r?\n/, 1)[0].trim();
    const bounded = (line: string) => clip(safeForLLM(line), 200);
    return { report_verdict: verdict ? bounded(verdict) : null, report_decisions: reportDecisionTitles(text).map(bounded) };
  } catch { return empty; }
}

// Read only the order index and stat its named copies. The index bound exceeds
// the host argv budget even after JSON escaping; it is not an attachment limit.
export function reportAttachments(dir: string, reportId: string | null): { attachments?: string[] } {
  if (!reportId || !REPORT_ID.test(reportId)) return {};
  try {
    const reports = path.join(fs.realpathSync(dir), 'helper-reports');
    if (!fs.lstatSync(reports).isDirectory()) return {};
    const folder = path.join(reports, reportId + '.files');
    if (!fs.lstatSync(folder).isDirectory()) return {};
    const index = readReportFile(folder + '.json', 64 * 1024 * 1024);
    if (!index) return {};
    const names: unknown = JSON.parse(index);
    if (!Array.isArray(names)) return {};
    const attachments: string[] = [];
    for (const name of names) {
      if (typeof name !== 'string' || !name || name === '.' || name === '..' || path.basename(name) !== name) return {};
      const file = path.join(folder, name);
      if (fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) attachments.push(file);
    }
    return attachments.length ? { attachments } : {};
  } catch { return {}; }
}

function reportDirectory(dir: string): string {
  const root = fs.realpathSync(dir);
  const reports = path.join(root, 'helper-reports');
  fs.mkdirSync(reports, { recursive: true });
  if (fs.lstatSync(reports).isSymbolicLink() || !fs.realpathSync(reports).startsWith(root + path.sep)) throw new Error('report_outside_state');
  return reports;
}

function guardRoot(dir: string): string {
  try { return fs.realpathSync(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return path.resolve(dir);
  }
}

function copyAttachment(source: string, destination: string): void {
  const input = fs.openSync(source, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    if (!fs.fstatSync(input).isFile()) throw new Error('invalid_file');
    const output = fs.openSync(destination, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o444);
    try {
      fs.fchmodSync(output, 0o444);
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let count: number;
      while ((count = fs.readSync(input, buffer, 0, buffer.length, null)) > 0) {
        let offset = 0;
        while (offset < count) offset += fs.writeSync(output, buffer, offset, count - offset);
      }
    } finally { fs.closeSync(output); }
  } finally { fs.closeSync(input); }
}

function stageAttachments(dir: string, declared: string[]) {
  const roots = [...channelStateDirs(dir, readSettledConfig(dir))].map(([, root]) => guardRoot(root));
  const userChannels = guardRoot(path.join(os.homedir(), '.claude', 'channels'));
  // mkdtemp creates the private directory atomically and exclusively.
  const staging = fs.mkdtempSync(path.join(reportDirectory(dir), '.staging-'));
  const names = new Map<string, string>();
  const used = new Set<string>();
  try {
    if (!fs.lstatSync(staging).isDirectory()) throw new Error('invalid_file');
    for (const file of new Set(declared)) {
      if (!path.isAbsolute(file)) throw new Error('invalid_file');
      const source = fs.realpathSync(file);
      if (roots.some(root => source.startsWith(root + path.sep) && !source.startsWith(path.join(root, 'inbox') + path.sep))) {
        throw new Error('invalid_file');
      }
      if (source.startsWith(userChannels + path.sep)) {
        const parts = path.relative(userChannels, source).split(path.sep);
        if (!(parts[0] === 'inbox' && parts.length > 1) && !(parts[1] === 'inbox' && parts.length > 2)) {
          throw new Error('invalid_file');
        }
      }
      const { base, name, ext } = path.parse(file);
      let stored = base;
      for (let suffix = 2; used.has(stored); suffix++) stored = `${name}-${suffix}${ext}`;
      copyAttachment(source, path.join(staging, stored));
      used.add(stored);
      names.set(file, stored);
    }
    return { staging, names };
  } catch {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error('invalid_file');
  }
}

/** Immutable report files confined to the pinned state root. */
export function storeHelperReport(
  dir: string, text: string, binding: { task: string | null; author: string },
  createId = () => randomBytes(5).toString('hex'),
  procedure = '',
  attachments?: ReturnType<typeof stageAttachments>,
): string {
  const reports = reportDirectory(dir);
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = createId();
    if (!REPORT_ID.test(id)) throw new Error('invalid_report_id');
    const file = path.join(reports, `${id}.md`);
    let fd: number;
    try { fd = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o444); }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('report_outside_state');
      continue;
    }
    const created = [file];
    let attachmentDir: string | undefined;
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
      if (attachments) {
        const target = path.join(reports, id + '.files');
        try { fs.mkdirSync(target, { mode: 0o700 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST' && fs.lstatSync(target).isSymbolicLink()) throw new Error('report_outside_state');
          throw error;
        }
        attachmentDir = target;
        if (!fs.lstatSync(target).isDirectory()) throw new Error('report_outside_state');
        const names = [...attachments.names.values()];
        write('.files.json', JSON.stringify(names) + '\n');
        for (const name of names) fs.renameSync(path.join(attachments.staging, name), path.join(target, name));
      }
      fs.writeFileSync(fd, text);
      return id;
    } catch (error) {
      if (attachmentDir) fs.rmSync(attachmentDir, { recursive: true, force: true });
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
  let attachments: ReturnType<typeof stageAttachments> | undefined;
  let report = '';
  try {
    if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('report_too_long');
    const delimiter = /^[^\S\r\n]*--- procedure ---[^\S\r\n]*\r?$/m.exec(text);
    const procedure = delimiter ? text.slice(delimiter.index + delimiter[0].length).trim() : '';
    if (delimiter) text = text.slice(0, delimiter.index);
    if (!text.trim()) throw new Error('empty');
    if (Array.isArray(flags.file) && flags.file.length) {
      if (kind === 'note') throw new Error('invalid_file');
      attachments = stageAttachments(dir, flags.file);
      const longestFirst = [...attachments.names].sort(([a], [b]) => b.length - a.length);
      for (const [file, name] of longestFirst) text = text.replaceAll(file, () => name);
    }

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
        report = storeHelperReport(dir, text, { task: id, author }, undefined, procedure, attachments);
        recorded = record;
        record.report_id = report;
        record.report_kind = kind;
        record.delivery = record.conversation ? 'pending' : 'no_channel';
      },
    });

    let delivery: ReportDelivery = 'no_channel';
    if (recorded.conversation) {
      // The report is already stored and recorded, so a send error becomes a
      // receipt rather than an exit the author would read as "not stored".
      try {
        const config = readSettledConfig(dir);
        const notice = loadMessages(dir, config.language).t('task_report_truncated');
        const [source, destination] = recorded.conversation.split(':');
        const [chatId, thread] = destination.split('~');
        const label = threadRecords(dir).filter(task => task.conversation === recorded.conversation).length >= 2
          && await classifyChat(dir, config, source, chatId, thread) === 'shared'
          ? `${recorded.handle} · ${clip(safeForLLM(recorded.title), 60)}: ` : '';
        delivery = deliveryOf(await sendToOwnedChat(dir, `${source}:${chatId}`, label + text, { config, thread, discordCapNotice: notice }));
      } catch { delivery = 'failed'; }
      // An unsettled record keeps `pending`, which the resident reports without resending.
      try { settleReportDelivery(dir, id, report, delivery); } catch {}
    }
    return { report, task: id, recorded: true, result_rev: recorded.result_rev, delivery };
  } catch (error) {
    if (attachments && report) {
      const folder = path.join(path.dirname(attachments.staging), report + '.files');
      fs.rmSync(folder, { recursive: true, force: true });
      fs.rmSync(folder + '.json', { force: true });
    }
    if (error instanceof Error && REFUSALS.has(error.message)) return { status: 'refused', reason: error.message };
    throw error;
  } finally {
    if (attachments) fs.rmSync(attachments.staging, { recursive: true, force: true });
  }
}
