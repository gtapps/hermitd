// Shared primitives for the scripts/*.ts verdict-line CLI contract (see
// CLAUDE.md § Token discipline): emit() writes a bare stdout token (e.g. `OK`)
// and exits 0; printJson() writes one JSON object line; emitJson() writes it
// and exits 1 when it carries an `error` key, else 0; failJson() prints a caught
// error as `{"error":"<token>"}` and sets exit 1 without exiting; readStdin() reads a
// heredoc payload to completion untrimmed (callers trim where the original
// per-script behavior trimmed); readJson() is a tolerant JSON-file reader for
// optional state files (null if missing or invalid); flagValue() reads one
// `--flag value` pair out of an argv slice; snakeToken() gives a persisted kebab
// token its stdout spelling.

import fs from 'node:fs';

type Json = any;

function emit(verdict: string): never {
  process.stdout.write(verdict + '\n');
  process.exit(0);
}

function printJson(obj: object): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function emitJson(obj: object): never {
  printJson(obj);
  process.exit('error' in obj ? 1 : 0);
}

/**
 * Report a caught error as `{"error":"<token>"}` with exit code 1. The message is
 * the token when it already reads as one (`snake_token` or `snake_token:detail`),
 * else `fallback`. Sets process.exitCode instead of exiting so pending work settles.
 */
function failJson(error: unknown, fallback = 'operation_failed'): void {
  const message = error instanceof Error ? error.message : '';
  printJson({ error: /^[a-z_]+(:.*)?$/s.test(message) ? message : fallback });
  process.exitCode = 1;
}

/**
 * The stdout spelling of a kebab-case token sourced from persisted or shared
 * vocabulary (a ledger outcome, a monitor health reason). Only the token before the
 * first `:` changes; detail after it is data. The source value stays as written.
 * Temporary: it goes away when the persisted vocabulary itself moves to snake_case.
 */
function snakeToken(token: string): string {
  const i = token.indexOf(':');
  return i === -1 ? token.replaceAll('-', '_') : token.slice(0, i).replaceAll('-', '_') + token.slice(i);
}

function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { buf += c; });
    process.stdin.on('error', () => {});
    process.stdin.on('end', () => resolve(buf));
  });
}

// A TTY never emits 'end' without Ctrl-D, so the flag alone is not enough to read.
function readStdinIfFlagged(argv: string[], flag: string): Promise<string> {
  return argv.includes(flag) && !process.stdin.isTTY ? readStdin() : Promise.resolve('');
}

function readJson(p: string): Json {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

// `--flag=value` (equals form), as distinct from flagValue's `--flag value`.
// Both forms are in use: the equals form reads better in skill prose, where the
// call is written by hand.
function flagEq(argv: string[], name: string): string | undefined {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
}

export { emit, printJson, emitJson, failJson, snakeToken, readStdin, readStdinIfFlagged, readJson, flagValue, flagEq };
