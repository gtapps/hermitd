export const isoSec = (d: Date) => d.toISOString().slice(0, 19) + 'Z';

export const utcDate = (d: Date) => d.toISOString().slice(0, 10);

export const daysAgo = (n: number) => new Date(Date.now() - n * 86400000);
