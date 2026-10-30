// Spend-cap status, shared by lib/prompt-stages/channel-status-responder.ts (the
// deterministic `status` hook, which prints budgetLine's operator-language line) and
// cost-report.ts's reflect verb (the --plain channel data, which carries budgetStatus's
// figures) so the two surfaces can't drift on which cap and spend they report. Lives
// here rather than in lib/budget.ts (which is pure evaluation, no I/O) because
// budgetStatus reads the cost index.

import { costLogPath } from './cc-compat';
import { costIndexPath, readCostIndex, computeIndex } from './cost-log';
import { todayYMD, thisWeekKey, thisMonthYYYYMM } from './time';
import { EN_MESSAGES, type Messages } from './messages';

type Json = any;

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function resolveTimezone(config: Json): string {
  return typeof config?.timezone === 'string' && config.timezone ? config.timezone : 'UTC';
}

// Reports the first cap set, in daily > weekly > monthly precedence — the
// shortest configured window is what an operator checking in mid-day cares
// about first.
type BudgetPeriod = 'daily' | 'weekly' | 'monthly';

function budgetStatus(dir: string, config: Json, timezone: string): { period: BudgetPeriod; spend: number; cap: number } | null {
  const budget = config?.budget;
  if (!budget) return null;
  const candidates: Array<[BudgetPeriod, number | null]> = [
    ['daily', typeof budget.daily_usd === 'number' ? budget.daily_usd : null],
    ['weekly', typeof budget.weekly_usd === 'number' ? budget.weekly_usd : null],
    ['monthly', typeof budget.monthly_usd === 'number' ? budget.monthly_usd : null],
  ];
  const active = candidates.find(([, cap]) => cap !== null);
  if (!active) return null;
  const [period, cap] = active;
  if (cap === null) return null;

  // A cap can be configured before any spend is ever logged — a missing/absent
  // cost-index means zero spend so far, not "nothing to report". When the on-disk
  // index is stale (version-mismatched after an upgrade, or tz-mismatched) we can't
  // rebuild it here (cost-tracker is the sole writer, and a paused hermit runs no
  // Stop turn), so fall back to a read-only in-memory scan for a truthful figure
  // rather than reporting a misleading $0.
  const idx = readCostIndex(costIndexPath(dir)) ?? computeIndex(costLogPath(dir), timezone);
  const spend = period === 'daily' ? idx?.by_date?.[todayYMD(timezone)]?.cost || 0
    : period === 'weekly' ? idx?.by_week?.[thisWeekKey(timezone)]?.cost || 0
    : idx?.by_month?.[thisMonthYYYYMM(timezone)]?.cost || 0;
  return { period, spend, cap };
}

function budgetLine(dir: string, config: Json, timezone: string, m: Messages = EN_MESSAGES): string | null {
  const status = budgetStatus(dir, config, timezone);
  if (!status) return null;
  const label = m.t(status.period === 'daily' ? 'spend_label_daily' : status.period === 'weekly' ? 'spend_label_weekly' : 'spend_label_monthly');
  return m.t('spend_cap_status', { label, spend: money(status.spend), cap: money(status.cap) });
}

export { money, resolveTimezone, budgetStatus, budgetLine };
