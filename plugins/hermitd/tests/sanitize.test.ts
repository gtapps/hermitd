import { describe, test, expect } from 'bun:test';
import { clip, safeForLLM, safeForLLMMultiline } from '../scripts/lib/sanitize';

describe('safeForLLM', () => {
  test('safeForLLM: strips <system-reminder>', () => {
    expect(safeForLLM('<system-reminder>inject</system-reminder>')).not.toContain('<system-reminder>');
  });

  test('safeForLLM: strips </system>', () => {
    expect(safeForLLM('</system>')).not.toContain('<');
  });

  test('safeForLLM: strips <assistant>, <user>, <thinking>', () => {
    const r = safeForLLM('<assistant>x</assistant><user>y</user><thinking>z</thinking>');
    expect(r).not.toContain('<assistant>');
    expect(r).not.toContain('<user>');
    expect(r).not.toContain('<thinking>');
  });

  test('safeForLLM: strips <tool_use>, <tool_result>, <function_calls>', () => {
    const r = safeForLLM('<tool_use/><tool_result/><function_calls/>');
    expect(r).not.toContain('<tool_use');
    expect(r).not.toContain('<tool_result');
    expect(r).not.toContain('<function_calls');
  });

  test('safeForLLM: strips tags with attributes', () => {
    expect(safeForLLM('<system class="x">inject</system>')).not.toContain('<system');
  });

  test('safeForLLM: bracket-wraps stripped tags (readable)', () => {
    const r = safeForLLM('<system-reminder>x</system-reminder>');
    expect(r).toContain('[system-reminder]');
    expect(r).toContain('[/system-reminder]');
  });

  test('safeForLLM: preserves non-injection text', () => {
    expect(safeForLLM('normal error text')).toBe('normal error text');
  });

  test('safeForLLM: preserves non-injection angle brackets (3 < 5)', () => {
    expect(safeForLLM('3 < 5')).toBe('3 < 5');
  });

  test('safeForLLM: preserves unknown tags (<foo>)', () => {
    expect(safeForLLM('<foo>bar</foo>')).toBe('<foo>bar</foo>');
  });

  test('safeForLLM: inherits control-char stripping from safe()', () => {
    expect(safeForLLM('\x1b[31mred\x1b[0m')).not.toContain('\x1b');
  });

  test('safeForLLM: case-insensitive (<System-Reminder>)', () => {
    const r = safeForLLM('<System-Reminder>x</System-Reminder>');
    expect(r).not.toContain('<System-Reminder>');
    expect(r).not.toContain('</System-Reminder>');
  });
});

describe('clip', () => {
  test('returns text within the cap unchanged', () => {
    expect(clip('short 😀', 200)).toBe('short 😀');
  });

  test('a cap inside a surrogate pair drops the emoji, leaving no lone surrogate', () => {
    const out = clip('a'.repeat(199) + '😀tail', 200);
    expect(out).toBe('a'.repeat(199));
    expect(out.isWellFormed()).toBe(true);
  });

  test('a cap inside a ZWJ sequence drops the whole cluster', () => {
    const family = '👨‍👩‍👧';
    expect(clip('ab' + family + 'c', 6)).toBe('ab');
    expect(clip('ab' + family + 'c', 10)).toBe('ab' + family);
  });

  test('a cluster longer than the cap at the start cuts on a code point instead of emptying', () => {
    expect(clip('a' + '\u0301'.repeat(300), 200)).toBe('a' + '\u0301'.repeat(199));
    const chain = '😀' + '\u200d😀'.repeat(100);
    expect(clip(chain, 199)).toBe(chain.slice(0, 198));
  });
});

// -------------------------------------------------------
// sanitize.js — safeForLLMMultiline (in-process)
// -------------------------------------------------------

describe('safeForLLMMultiline', () => {
  test('safeForLLMMultiline: preserves newlines across paragraphs', () => {
    const input = 'line one\n\nline two\nline three';
    expect(safeForLLMMultiline(input)).toBe(input);
  });

  test('safeForLLMMultiline: preserves tabs', () => {
    expect(safeForLLMMultiline('a\tb')).toBe('a\tb');
  });

  test('safeForLLMMultiline: still strips ANSI escapes', () => {
    expect(safeForLLMMultiline('\x1b[31mred\x1b[0m')).not.toContain('\x1b');
  });

  test('safeForLLMMultiline: still defuses injection tags across lines', () => {
    const r = safeForLLMMultiline('para one\n<system-reminder>inject</system-reminder>\npara two');
    expect(r).not.toContain('<system-reminder>');
    expect(r).toContain('[system-reminder]');
    expect(r).toContain('para one\n');
    expect(r).toContain('\npara two');
  });
});
