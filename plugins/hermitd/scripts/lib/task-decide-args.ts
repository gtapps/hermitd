export const TASK_ID = /^T-\d{8}-\d{6}(-[a-z0-9])?$/;
export type DecideArgs = { id?: string; token: string };

export function parseDecideArgs(tokens: string[]): DecideArgs | null {
  const [first, second] = tokens;
  const id = first !== undefined && TASK_ID.test(first) ? first : undefined;
  const token = id ? second : first;
  if (tokens.length !== (id ? 2 : 1) || !token || !/^(yes|no|[1-9]\d*|close|cancel)$/.test(token)) return null;
  if (!id && (token === 'close' || token === 'cancel')) return null;
  return { ...(id ? { id } : {}), token };
}

export function canonicalDecideCommand(parsed: DecideArgs): string {
  return `.hermit/bin/hermitd-run task decide .hermit${parsed.id ? ' ' + parsed.id : ''} ${parsed.token}`;
}
