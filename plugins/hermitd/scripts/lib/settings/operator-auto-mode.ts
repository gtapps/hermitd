import path from 'node:path';
import { isDict, pyTruthy } from '../channel-config';
import { foreignArtifactBackend } from '../config-read';
import { sha256 } from '../hash';
import { defaultConfigDir } from '../setup-token';
import { automodeAllowEntry, AUTOMODE_ENV_ENTRIES, AUTOMODE_SOFT_DENY_ENTRY, AUTOMODE_WATCH_ALLOW_ENTRY, SEALED_SETTINGS_OPS } from './automode-entries';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '../../..');
export const LISTS = ['environment', 'allow', 'soft_deny', 'hard_deny'] as const;

export function artifactGrantApplies(config: any): boolean {
  const artifacts = isDict(config.artifacts) ? config.artifacts : {};
  const anyPage = ['dashboard', 'weekly_review'].some((key) => pyTruthy(artifacts[key]));
  return anyPage && artifacts.publish_authorized === true && foreignArtifactBackend(config) === null;
}

export function generatedAutoMode(config: any): Record<string, string[]> {
  const ops = artifactGrantApplies(config)
    ? SEALED_SETTINGS_OPS
    : SEALED_SETTINGS_OPS.filter((op) => op !== 'artifact-allow');
  return {
    soft_deny: ['$defaults', AUTOMODE_SOFT_DENY_ENTRY],
    allow: ['$defaults', automodeAllowEntry(path.join(defaultConfigDir(), 'plugins'), PLUGIN_ROOT, ops), AUTOMODE_WATCH_ALLOW_ENTRY],
    environment: ['$defaults', ...AUTOMODE_ENV_ENTRIES],
  };
}

export function mergeOperatorAutoMode(
  generated: Record<string, unknown>, operator: unknown,
): { autoMode: Record<string, unknown>; warnings: string[] } {
  const autoMode = structuredClone(generated);
  const warnings: string[] = [];
  if (operator === undefined) return { autoMode, warnings };
  if (!isDict(operator)) {
    warnings.push('claude-settings.json `autoMode` is not an object; ignoring the operator autoMode.');
    return { autoMode, warnings };
  }
  for (const [key, value] of Object.entries(operator as Record<string, unknown>)) {
    if (LISTS.some((list) => list === key)) {
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        warnings.push(`claude-settings.json autoMode \`${key}\` is not a string array; ignoring that list.`);
        continue;
      }
      if (key === 'hard_deny' && !value.includes('$defaults')) {
        warnings.push('claude-settings.json autoMode `hard_deny` lacks `$defaults` and replaces Claude Code\'s built-in hard block.');
      }
      const base = autoMode[key];
      autoMode[key] = Array.isArray(base)
        ? [...base, ...value.filter((item) => item !== '$defaults' || !base.includes('$defaults'))]
        : [...value];
    } else if (!(key in autoMode)) {
      autoMode[key] = structuredClone(value);
    }
  }
  return { autoMode, warnings };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isDict(value)) {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(obj).sort().map((key) => [key, canonical(obj[key])]));
  }
  return value;
}

export function operatorAutoModeFingerprint(operator: unknown): string {
  const json = operator === undefined ? 'absent' : JSON.stringify(canonical(operator));
  return sha256(json);
}
