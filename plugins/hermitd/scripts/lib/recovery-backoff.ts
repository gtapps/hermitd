// Both recovery producers defer each distinct outage by ten, thirty, then sixty minutes.
export function recoveryBackoff(failureAt: number, refunds: number, now: number): string {
  const delay = [10, 30, 60][Math.min(refunds, 2)] * 60000;
  return new Date(Math.min(failureAt + delay, now + 60 * 60000)).toISOString();
}
