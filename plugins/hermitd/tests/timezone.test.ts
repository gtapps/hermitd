import { test, expect } from 'bun:test';
import { isUsableTimeZone } from '../scripts/lib/time';

for (const zone of ['Europe/Lisbon', 'UTC', 'WET', 'EST']) {
  test(`scheduler accepts ${zone}`, () => expect(isUsableTimeZone(zone)).toBe(true));
}
for (const zone of ['WEST', 'CEST', '+01:00', 'Lisbon', '']) {
  test(`scheduler rejects ${JSON.stringify(zone)}`, () => expect(isUsableTimeZone(zone)).toBe(false));
}
