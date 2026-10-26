// Preloaded into the plugin scripts the generators run (lib.ts withInstall). It
// freezes Date at $HERMIT_NOW so a regenerated stand-in is identical on every run:
// the env var alone does not reach every clock read (the heartbeat active-hours
// gate and task record stamps use the wall clock).

const fixed = Date.parse(process.env.HERMIT_NOW ?? '');
if (Number.isNaN(fixed)) throw new Error('fixed-clock: HERMIT_NOW is not a date');
const Real = Date;
class FixedDate extends Real {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(fixed);
    else super(...(args as [string]));
  }
  static override now(): number { return fixed; }
}
globalThis.Date = FixedDate as DateConstructor;
