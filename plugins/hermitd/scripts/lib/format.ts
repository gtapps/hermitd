// Returns a magnitude-suffixed count, e.g. "532M", "3.3M", "45.0K", "304K", "999", "0".
function kStr(n: number): string {
  const v = n || 0;
  if (v === 0) return '0';
  const fmt = (scaled: number, suffix: string) =>
    (scaled < 100 ? scaled.toFixed(1) : String(Math.round(scaled))) + suffix;
  // thresholds sit half a unit below the next power of 1000 so rounding never overflows
  // the suffix (e.g. 999999 -> "1.0M" instead of "1000K")
  if (v >= 999.5e6) return fmt(v / 1e9, 'B');
  if (v >= 999.5e3) return fmt(v / 1e6, 'M');
  if (v >= 1e3) return fmt(v / 1e3, 'K');
  return String(Math.round(v));
}

function formatTokens(n: number): string {
  return kStr(n) + ' tokens';
}

// Rounds a dollar amount to 4 decimal places.
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export { kStr, formatTokens, round4 };
