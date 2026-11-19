// Shared primitives for the scripts/*.ts verdict-line CLI contract (see
// CLAUDE.md § Token discipline): writeStdout() writes stdout synchronously, so an
// exit right after it cannot drop the tail of a large write; emit() writes a bare
// stdout token (e.g. `OK`) and exits 0; printJson() writes one JSON object line; emitJson() writes it
// and exits 1 when it carries an `error` key, else 0; exitError() prints a usage
// or argument error as `{"error":"<token>"}` and exits 1; failJson() prints a caught
// error as `{"error":"<token>"}` and sets exit 1 without exiting; readStdin() reads a
// heredoc payload to completion untrimmed (callers trim where the original
// per-script behavior trimmed); readJson() is a tolerant JSON-file reader for
// optional state files (null if missing or invalid); flagValue() reads one
// `--flag value` pair out of an argv slice; snakeToken() gives a persisted kebab
// token its stdout spelling.

import fs from 'node:fs';

type Json = any;

// Synchronous on purpose: process.stdout.write may still hold the tail of a large
// write for a pipe when process.exit runs, and exit drops it. EAGAIN means an earlier
// process.stdout use left the pipe non-blocking, so wait for the reader. Any other
// error (a closed reader) ends the write and leaves the exit code to the caller.
function writeStdout(text: string): void {
  const buf = Buffer.from(text);
  for (let offset = 0; offset < buf.length;) {
    try { offset += fs.writeSync(1, buf, offset); } catch (e: any) {
      if (e?.code !== 'EAGAIN') return;
      Bun.sleepSync(1);
    }
  }
}

function emit(verdict: string): never {
  writeStdout(verdict + '\n');
  process.exit(0);
}

function printJson(obj: object): void {
  writeStdout(JSON.stringify(obj) + '\n');
}

function emitJson(obj: object): never {
  printJson(obj);
  process.exit('error' in obj ? 1 : 0);
}

function exitError(token = 'usage'): never {
  return emitJson({ error: token });
}

/**
 * Report a caught error (or a token string) as `{"error":"<token>"}` with exit code 1.
 * The message is the token when it already reads as one (`snake_token` or
 * `snake_token:detail`), else `fallback`. Sets process.exitCode instead of exiting so
 * pending work settles.
 */
function failJson(error: unknown, fallback = 'operation_failed'): void {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
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

/** Read a value from the terminal with echo off; Enter ends it, Ctrl-C cancels. */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    let value = '';
    const done = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
    stdin.resume();
  });
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

export { writeStdout, emit, printJson, emitJson, exitError, failJson, snakeToken, readHidden, readStdin, readStdinIfFlagged, readJson, flagValue, flagEq };
