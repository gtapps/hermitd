#!/usr/bin/env bun
// Install this plugin's fixed native asks.
import fs from 'node:fs';
import path from 'node:path';

class Failure extends Error {}
function read(file: string): any {
  let value: any;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return {}; throw new Failure('invalid_settings'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Failure('invalid_settings');
  return value;
}
function validate(settings: any): void {
  if (settings.permissions !== undefined && (!settings.permissions || typeof settings.permissions !== 'object' || Array.isArray(settings.permissions))) throw new Failure('invalid_permissions');
  for (const key of ['ask', 'deny']) {
    const entries = settings.permissions?.[key];
    if (entries !== undefined && (!Array.isArray(entries) || entries.some((v: unknown) => typeof v !== 'string'))) throw new Failure(`invalid_permissions:${key}`);
  }
}
try {
  const args = process.argv.slice(2);
  const [target] = args;
  if (args.length !== 1 || !target || !['settings.json', 'settings.local.json'].includes(path.basename(target))) throw new Failure('usage');
  const settingsPath = path.resolve(target);
  if (path.basename(path.dirname(settingsPath)) !== '.claude') throw new Failure('not_project_settings');
  const rules: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '../state-templates/native-permissions.json'), 'utf8')).ask;
  const settings = read(settingsPath);
  validate(settings);
  const before = JSON.stringify(settings);
  settings.permissions ??= {};
  settings.permissions.ask = [...new Set([...(settings.permissions.ask ?? []), ...rules])];
  if (JSON.stringify(settings) !== before) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }
  const conflicts = settings.permissions?.deny?.filter((rule: string) => rules.includes(rule)) ?? [];
  console.log(conflicts.length ? JSON.stringify({ status: 'installed', deny_conflicts: conflicts }) : 'OK');
} catch (error: any) {
  console.log(JSON.stringify({ error: error instanceof Failure ? error.message : `install_failed:${error?.message ?? error}` }));
  process.exit(1);
}
