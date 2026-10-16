/** Shared lateness policy for monitor marks and operator-facing later checks. */
export function maxLatenessMinutes(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1440 ? value : 60;
}
