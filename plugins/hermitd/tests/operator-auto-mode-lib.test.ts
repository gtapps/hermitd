import { describe, expect, test } from 'bun:test';
import { generatedAutoMode, mergeOperatorAutoMode, operatorAutoModeFingerprint } from '../scripts/lib/settings/operator-auto-mode';

describe('operator auto-mode merge', () => {
  test('appends all lists, deduplicates defaults, and preserves inputs', () => {
    const generated = {
      environment: ['$defaults', 'generated environment'],
      allow: ['$defaults', 'generated allow'],
      soft_deny: ['$defaults', 'generated soft'],
      hard_deny: ['$defaults', 'generated hard'],
      classifyAllShell: true,
    };
    const operator = {
      environment: ['$defaults', 'operator environment'],
      allow: ['$defaults', 'operator allow'],
      soft_deny: ['$defaults', 'operator soft'],
      hard_deny: ['$defaults', 'operator hard'],
      classifyAllShell: false,
      extra: { nested: true },
    };
    const before = JSON.stringify({ generated, operator });
    const { autoMode, warnings } = mergeOperatorAutoMode(generated, operator);
    expect(autoMode).toEqual({
      environment: ['$defaults', 'generated environment', 'operator environment'],
      allow: ['$defaults', 'generated allow', 'operator allow'],
      soft_deny: ['$defaults', 'generated soft', 'operator soft'],
      hard_deny: ['$defaults', 'generated hard', 'operator hard'],
      classifyAllShell: true,
      extra: { nested: true },
    });
    expect(warnings).toEqual([]);
    expect(JSON.stringify({ generated, operator })).toBe(before);
    (autoMode.extra as { nested: boolean }).nested = false;
    expect(operator.extra.nested).toBe(true);
  });

  test('keeps operator-only lists and keys and warns about replacing the hard block', () => {
    const merged = mergeOperatorAutoMode(generatedAutoMode({}), {
      hard_deny: ['never push'], classifyAllShell: true,
    });
    expect(merged.autoMode.hard_deny).toEqual(['never push']);
    expect(merged.autoMode.classifyAllShell).toBe(true);
    expect(merged.warnings.join(' ')).toContain('built-in hard block');
  });

  test('skips malformed lists independently and warns on non-object', () => {
    const generated = generatedAutoMode({});
    const merged = mergeOperatorAutoMode(generated, { allow: ['valid', 42], soft_deny: ['rule'] });
    expect(merged.autoMode.allow).toEqual(generated.allow);
    expect(merged.autoMode.soft_deny).toEqual([...generated.soft_deny, 'rule']);
    expect(merged.warnings.join(' ')).toContain('allow');
    expect(mergeOperatorAutoMode(generated, null).warnings).toHaveLength(1);
  });

  test('fingerprints canonical keys and changes on a sentence', () => {
    expect(operatorAutoModeFingerprint({ allow: ['a'], extra: { z: 1, a: 2 } }))
      .toBe(operatorAutoModeFingerprint({ extra: { a: 2, z: 1 }, allow: ['a'] }));
    expect(operatorAutoModeFingerprint({ allow: ['a'] })).not.toBe(operatorAutoModeFingerprint({ allow: ['b'] }));
    expect(operatorAutoModeFingerprint(undefined)).not.toBe(operatorAutoModeFingerprint(null));
  });
});
