import path from 'node:path';
import { readTasks, taskListing } from './tasks';
import { taskReport, selectTodayReports, type TaskReport } from './task-report';
import { readSettledConfig } from './config-read';
import { dutyRows } from './duty-summary';
import { scanProposals } from './proposals/index-rebuild';

export type BriefMode = 'morning' | 'evening' | 'daily';

export function briefDigest(dir: string, mode: BriefMode, reference = new Date()) {
  const tasks = readTasks(dir);
  const reports = tasks.map(record => taskReport(dir, record));
  const selected = selectTodayReports(reports, readSettledConfig(dir).timezone ?? 'UTC', reference);
  const newest = (a: TaskReport, b: TaskReport) => (b.closed_at ?? b.opened_at).localeCompare(a.closed_at ?? a.opened_at);
  const omitted = { clipped: 0, lessons: 0, records: 0, decisions: 0, open: 0, proposals: 0, duties: 0 };
  const clip = (value: string, limit = 200): string => {
    if (value.length <= limit) return value;
    omitted.clipped++;
    const end = /[\uD800-\uDBFF]/.test(value[limit - 1]) ? limit - 1 : limit;
    return value.slice(0, end);
  };
  const nullable = (value: string | null) => value === null ? null : clip(value);
  const recordRow = (report: TaskReport, latest = false) => {
    const result = clip(report.result ?? '', !latest && report.lessons.length ? 4000 : 400);
    const result_truncated = result !== (report.result ?? '');
    const lessons = report.lessons.filter(lesson => {
      if (latest || result_truncated || lesson.length > 400) { omitted.lessons++; return false; }
      return true;
    });
    return { id: path.basename(report.source_path), outcome: report.outcome, title: clip(report.title), result,
      result_truncated, closed_reason: clip(report.closed_reason ?? ''), opened_at: report.opened_at,
      closed_at: report.closed_at, waiting_on: nullable(report.waiting_on), lessons };
  };
  const records = mode === 'morning' ? [] : [...selected.closed_today, ...selected.opened_today.filter(row => row.closed_at === null)].sort(newest).map(row => recordRow(row));
  const latestReport = mode === 'morning' ? [...reports].sort(newest)[0] : undefined;
  const latest = latestReport ? recordRow(latestReport, true) : null;
  const open = tasks.filter(row => row.status === 'open' && row.owner === 'resident').sort((a, b) => b.opened_at.localeCompare(a.opened_at)).map(row => {
    const listing = taskListing(row, tasks);
    const late = listing.includes('late');
    const state = listing.includes('finishing') && !late ? 'finishing' : row.result ? 'unconfirmed' : row.waiting_on ? 'waiting' : 'runnable';
    return { id: row.id, title: clip(row.title), state, waiting_on: nullable(row.waiting_on), due: row.due, late };
  });
  const decisions = reports.flatMap(report => report.decisions.flatMap(line => {
    const match = line.match(/^(\S+)\s+(.+)$/s);
    const stamp = match ? Date.parse(match[1]) : NaN;
    if (!match || !Number.isFinite(stamp) || stamp < reference.getTime() - 86400000 || stamp > reference.getTime()) return [];
    if (match[2].length > 400) { omitted.decisions++; return []; }
    return [{ task_title: clip(report.title), text: match[2], stamp }];
  })).sort((a, b) => b.stamp - a.stamp).map(({ task_title, text }) => ({ task_title, text }));
  const duties = dutyRows(dir).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'string' ? clip(value) : value])));
  const proposals = mode === 'morning' ? (scanProposals(dir)?.proposals ?? []).filter(row => row.status === 'proposed' && row.source === 'auto-detected').map(row => ({ id: row.id, title: clip(row.title ?? '') })) : [];
  const digest = { mode, today: selected.today, ...(mode === 'morning' ? { latest, proposals } : { records }), open, decisions, duties, omitted };
  const bytes = () => Buffer.byteLength(JSON.stringify(digest) + '\n');
  while (bytes() > 25000) {
    const withLessons = records.findLast(row => row.lessons.length);
    if (withLessons) { withLessons.lessons.pop(); omitted.lessons++; }
    else if (records.length) { records.pop(); omitted.records++; }
    else if (decisions.length) { decisions.pop(); omitted.decisions++; }
    else {
      const runnable = open.findIndex(row => row.state === 'runnable');
      if (runnable !== -1) { open.splice(runnable, 1); omitted.open++; }
      else if (proposals.length) { proposals.pop(); omitted.proposals++; }
      else if (open.length) { open.shift(); omitted.open++; }
      else if (duties.length) { duties.pop(); omitted.duties++; }
    }
  }
  return digest;
}
