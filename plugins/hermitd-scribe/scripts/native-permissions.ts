#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';

// A failure whose message is already the `{"error"}` token.
class Fail extends Error {}

function install(): string[] {
  const [target, ...extra] = process.argv.slice(2);
  if (!target || extra.length || !['settings.json', 'settings.local.json'].includes(path.basename(target))) {
    throw new Fail('usage');
  }
  const settingsPath = path.resolve(target);
  if (path.basename(path.dirname(settingsPath)) !== '.claude') throw new Fail('not_project_settings');

  let settings: any;
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch (error: any) {
    if (error.code === 'ENOENT') settings = {};
    else if (error instanceof SyntaxError) throw new Fail('invalid_settings');
    else throw error;
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Fail('invalid_settings');
  if (settings.permissions !== undefined && (!settings.permissions || typeof settings.permissions !== 'object' || Array.isArray(settings.permissions))) {
    throw new Fail('invalid_permissions');
  }
  for (const key of ['ask', 'allow', 'deny']) {
    const entries = settings.permissions?.[key];
    if (entries !== undefined && (!Array.isArray(entries) || entries.some((value: unknown) => typeof value !== 'string'))) {
      throw new Fail(`invalid_permissions:${key}`);
    }
  }

  const rules: string[] = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '../state-templates/native-permissions.json'), 'utf8')).ask;
  const before = JSON.stringify(settings);
  settings.permissions ??= {};
  settings.permissions.ask = [...new Set([...(settings.permissions.ask ?? []), ...rules])];
  if (JSON.stringify(settings) !== before) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }
  return settings.permissions.deny?.filter((rule: string) => rules.includes(rule)) ?? [];
}

try {
  const conflicts = install();
  console.log(conflicts.length ? JSON.stringify({ status: 'installed', deny_conflicts: conflicts }) : 'OK');
} catch (error: any) {
  console.log(JSON.stringify({ error: error instanceof Fail ? error.message : `install_failed:${error.message}` }));
  process.exit(1);
}
