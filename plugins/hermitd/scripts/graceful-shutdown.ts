#!/usr/bin/env bun
// Usage: hermitd-run graceful-shutdown [--timeout <seconds>]
// Runs the resident's shutdown skill through the core mod and waits for its turn to settle.
import { hermitDir } from './lib/cc-compat';
import { exitError, flagValue, printJson } from './lib/cli';
import { gracefulShutdown } from './lib/shutdown';

const args = process.argv.slice(2);
const timeout = flagValue(args, '--timeout');
if (args.some(a => a.startsWith('--') && a !== '--timeout')) exitError('invalid_flag');
if (timeout !== undefined && !/^\d+$/.test(timeout)) exitError('invalid_timeout');
printJson(await gracefulShutdown(hermitDir(), timeout === undefined ? {} : { timeoutSecs: Number(timeout) }));
