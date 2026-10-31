#!/usr/bin/env bun
import { browserLease } from './lib/browser-lease';
import { emitJson, failJson } from './lib/cli';

if (import.meta.main) {
  const [action, task, ...extra] = process.argv.slice(2);
  try {
    if (!['claim', 'release', 'status'].includes(action) || extra.length || (action === 'status' && task !== undefined)) {
      throw new Error('usage: browser claim <task> | release [task] | status');
    }
    emitJson(browserLease(action as 'claim' | 'release' | 'status', task));
  } catch (error) {
    failJson(error);
  }
}
