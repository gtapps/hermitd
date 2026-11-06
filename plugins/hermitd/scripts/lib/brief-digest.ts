import path from 'node:path';
import { briefVisibility } from './channel-auth';
import { conversationKey, isKey } from './conversation-key';
import { ownedTarget, resolve as resolveHomeTarget } from '../resolve-outbound-channel';
import { readTasks, taskListing } from './tasks';
import { taskReport, selectTodayReports, type TaskReport } from './task-report';
import { readSettledConfig } from './config-read';
import { dutyRows } from './duty-summary';
import { scanProposals } from './proposals/index-rebuild';
import { homeChatKey } from './proposals/micro';

export type BriefMode = 'morning' | 'evening' | 'daily';

export interface BriefSelector { routine?: string; chat?: string }

export function briefDestination(config: any, selector: BriefSelector): string | null {
  if (selector.routine && selector.chat) throw new Error('invalid_arguments');
  if (selector.chat !== undefined) {
    if (!isKey(selector.chat)) throw new Error('invalid_key');
    return selector.chat;
  }
  if (selector.routine !== undefined) {
    if (!Array.isArray(config.routines) || !config.routines.some((row: any) => row?.id === selector.routine)) throw new Error('unknown_routine');
    const target = ownedTarget(config.routines, selector.routine) ?? resolveHomeTarget(config.channels);
    return target ? conversationKey(target.id, target.chat_id) : null;
  }
  return null;
}

/** Agent-wide steps (queue aging, upgrade check, dashboard, proposals, duties) belong to the whole agent and its home chat. */
function agentSteps(config: any, scope: unknown, destination: string | null): boolean {
  return scope === null || (destination !== null && destination.split('~')[0] === homeChatKey(config.channels));
}

export async function briefContext(dir: string, selector: BriefSelector = {}) {
  const config = readSettledConfig(dir);
  const destination = briefDestination(config, selector);
  const { scope } = await briefVisibility(dir, config, destination, []);
  return { scope: scope === null ? 'agent' : 'chat', agent_steps: agentSteps(config, scope, destination), destination };
}

export async function briefDigest(dir: string, mode: BriefMode, reference = new Date(), selector: BriefSelector = {}) {
  const tasks = readTasks(dir);
  const reports = tasks.map(record => taskReport(dir, record));
  const config = readSettledConfig(dir);
  const selected = selectTodayReports(reports, config.timezone ?? 'UTC', reference);
  const destination = briefDestination(config, selector);
  const recentDecision = (line: string) => {
    const match = line.match(/^(\S+)\s+(.+)$/s);
    const stamp = match ? Date.parse(match[1]) : NaN;
    return match && Number.isFinite(stamp) && stamp >= reference.getTime() - 86400000 && stamp <= reference.getTime() ? { stamp, text: match[2] } : null;
  };
  const reportById = new Map(reports.map(report => [path.basename(report.source_path, '.md'), report]));
  const todayIds = new Set([...selected.closed_today, ...selected.opened_today].map(row => path.basename(row.source_path, '.md')));
  // Morning needs only open work and the newest record, so twenty recent closed records bound its thread lookups.
  const recentClosed = new Set(mode === 'morning' ? tasks.filter(row => row.status !== 'open')
    .sort((a, b) => (b.closed_at ?? b.opened_at).localeCompare(a.closed_at ?? a.opened_at)).slice(0, 20).map(row => row.id) : []);
  const candidates = tasks.filter(row => row.status === 'open' || recentClosed.has(row.id) || todayIds.has(row.id)
    || reportById.get(row.id)?.decisions.some(line => recentDecision(line) !== null));
  const visibility = await briefVisibility(dir, config, destination, candidates);
  const visible = new Set(visibility.visible.map(row => row.id));
  const visibleReport = (row: TaskReport) => visible.has(path.basename(row.source_path, '.md'));
  const scope = visibility.scope === null ? 'agent' : 'chat';
  const agent_steps = agentSteps(config, visibility.scope, destination);
  const newest = (a: TaskReport, b: TaskReport) => (b.closed_at ?? b.opened_at).localeCompare(a.closed_at ?? a.opened_at);
  const omitted = { clipped: 0, lessons: 0, records: 0, decisions: 0, open: 0, proposals: 0, duties: 0 };
  const openIds = new Set(tasks.filter(row => row.status === 'open').map(row => row.id));
  omitted.open += visibility.unresolved.filter(id => openIds.has(id)).length;
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
    const lessons = latest ? [] : report.lessons.filter(lesson => {
      if (result_truncated || lesson.length > 400) { omitted.lessons++; return false; }
      return true;
    });
    return { id: path.basename(report.source_path, '.md'), outcome: report.outcome, title: clip(report.title), result,
      result_truncated, closed_reason: clip(report.closed_reason ?? ''), opened_at: report.opened_at,
      closed_at: report.closed_at, waiting_on: nullable(report.waiting_on), lessons };
  };
  const records = mode === 'morning' ? [] : [...selected.closed_today, ...selected.opened_today.filter(row => row.closed_at === null)].filter(visibleReport).sort(newest).map(row => recordRow(row));
  const latestReport = mode === 'morning' ? reports.filter(visibleReport).sort(newest)[0] : undefined;
  const latest = latestReport ? recordRow(latestReport, true) : null;
  const open = tasks.filter(row => row.status === 'open' && visible.has(row.id)).sort((a, b) => b.opened_at.localeCompare(a.opened_at)).map(row => {
    const listing = taskListing(row, tasks);
    const late = listing.includes('late');
    const state = row.owner !== 'resident' && !row.result && !row.waiting_on ? 'delegated' : listing.includes('finishing') && !late ? 'finishing' : row.result ? 'unconfirmed' : row.waiting_on ? 'waiting' : 'runnable';
    return { id: row.id, title: clip(row.title), state, waiting_on: nullable(row.waiting_on), due: row.due, late };
  });
  const decisions = reports.filter(visibleReport).flatMap(report => report.decisions.flatMap(line => {
    const recent = recentDecision(line);
    if (!recent) return [];
    if (recent.text.length > 400) { omitted.decisions++; return []; }
    return [{ task_title: clip(report.title), text: recent.text, stamp: recent.stamp }];
  })).sort((a, b) => b.stamp - a.stamp).map(({ task_title, text }) => ({ task_title, text }));
  const duties = (agent_steps ? dutyRows(dir) : []).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'string' ? clip(value) : value])));
  const proposals = mode === 'morning' && agent_steps ? (scanProposals(dir)?.proposals ?? []).filter(row => row.status === 'proposed' && row.source === 'auto-detected').map(row => ({ id: row.id, title: clip(row.title ?? '') })) : [];
  const digest = { mode, today: selected.today, scope, agent_steps, ...(mode === 'morning' ? { latest, proposals } : { records }), open, decisions, duties, omitted };
  const bytes = () => Buffer.byteLength(JSON.stringify(digest) + '\n');
  while (bytes() > 25000) {
    const withLessons = records.findLast(row => row.lessons.length);
    if (withLessons) {
      withLessons.lessons.pop();
      omitted.lessons++;
      // The long excerpt exists only to judge lessons.
      if (!withLessons.lessons.length && withLessons.result.length > 400) {
        withLessons.result = clip(withLessons.result, 400);
        withLessons.result_truncated = true;
      }
    }
    else if (records.length) { records.pop(); omitted.records++; }
    else if (decisions.length) { decisions.pop(); omitted.decisions++; }
    else {
      const runnable = open.findIndex(row => row.state === 'runnable' || row.state === 'delegated');
      if (runnable !== -1) { open.splice(runnable, 1); omitted.open++; }
      else if (proposals.length) { proposals.pop(); omitted.proposals++; }
      else if (open.length) { open.shift(); omitted.open++; }
      else if (duties.length) { duties.pop(); omitted.duties++; }
    }
  }
  return digest;
}
