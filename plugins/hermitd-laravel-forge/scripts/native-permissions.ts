#!/usr/bin/env bun
// Install this plugin's fixed native asks and denies without changing operator settings.
// Prints OK, {"status":"installed","deny_conflicts":[...]} or {"error":"<token>"} (exit 1).
import fs from 'node:fs';
import path from 'node:path';

class Fail extends Error {}

function read(file: string): any {
  let value: any;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error: any) {
    if (error.code === 'ENOENT') return {};
    if (error instanceof SyntaxError) throw new Fail('invalid_settings');
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Fail('invalid_settings');
  return value;
}
function validate(settings: any): void {
  if (settings.permissions !== undefined && (!settings.permissions || typeof settings.permissions !== 'object' || Array.isArray(settings.permissions))) throw new Fail('invalid_permissions');
  for (const key of ['ask', 'deny']) {
    const entries = settings.permissions?.[key];
    if (entries !== undefined && (!Array.isArray(entries) || entries.some((v: unknown) => typeof v !== 'string'))) throw new Fail(`invalid_permissions:${key}`);
  }
}
function install(): string[] {
  const [target, ...extra] = process.argv.slice(2);
  if (!target || !['settings.json', 'settings.local.json'].includes(path.basename(target)) || extra.length > 0) throw new Fail('usage');
  const settingsPath = path.resolve(target);
  if (path.basename(path.dirname(settingsPath)) !== '.claude') throw new Fail('not_project_settings');
  const template: { ask: string[]; deny: string[] } = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '../state-templates/native-permissions.json'), 'utf8'));
  const rules = template.ask;
  const settings = read(settingsPath);
  validate(settings);
  const before = JSON.stringify(settings);
  settings.permissions ??= {};
  settings.permissions.ask = [...new Set([...(settings.permissions.ask ?? []), ...rules])];
  settings.permissions.deny = [...new Set([...(settings.permissions.deny ?? []), ...template.deny])];
  if (JSON.stringify(settings) !== before) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }
  return settings.permissions.deny.filter((rule: string) => rules.includes(rule));
}

try {
  const conflicts = install();
  console.log(conflicts.length ? JSON.stringify({ status: 'installed', deny_conflicts: conflicts }) : 'OK');
} catch (error: any) {
  console.log(JSON.stringify({ error: error instanceof Fail ? error.message : `install_failed:${error?.message ?? error}` }));
  process.exit(1);
}
