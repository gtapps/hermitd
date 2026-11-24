// WP7 tier 1: src/yaml.ts wrapper tests — proves the wrapper closes the
// divergences pinned by tests/yaml-parity.test.ts.
//
// Core property, per corpus file: parseYaml(text) -> dumpYaml -> Python
// yaml.safe_load reads back EXACTLY the parsed value (type-tagged deep
// equality, no known-divergence exception list — unlike the parity spike's
// gate (c), which needed KNOWN_DUMP_DIVERGENCES).
//
// The python-subprocess comparator (resolvePython / PY_TYPED / tagBun) reuses
// the parity test's pattern.

import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { dumpYaml, parseYaml } from '../src/yaml';

const CORPUS_DIR = join(import.meta.dir, 'fixtures', 'yaml-corpus');

// ---------------------------------------------------------------------------
// Python subprocess comparator (same pattern as yaml-parity.test.ts)
// ---------------------------------------------------------------------------

const PY_TYPED = `
import yaml, json, sys, datetime
def tag(v):
    if isinstance(v, dict): return {k: tag(x) for k, x in v.items()}
    if isinstance(v, list): return [tag(x) for x in v]
    if isinstance(v, bool): return {"t": "bool", "v": v}
    if isinstance(v, datetime.datetime): return {"t": "datetime", "v": v.isoformat()}
    if isinstance(v, datetime.date): return {"t": "date", "v": v.isoformat()}
    if isinstance(v, float):
        if v != v: return {"t": "float", "v": "nan"}
        if v == float("inf"): return {"t": "float", "v": "inf"}
        if v == float("-inf"): return {"t": "float", "v": "-inf"}
        return {"t": "float", "v": v}
    if isinstance(v, int): return {"t": "int", "v": v}
    if isinstance(v, str): return {"t": "str", "v": v}
    if v is None: return {"t": "null", "v": None}
    return {"t": type(v).__name__, "v": str(v)}
try:
    print(json.dumps({"ok": True, "data": tag(yaml.safe_load(sys.stdin.read()))}))
except Exception as e:
    print(json.dumps({"ok": False, "error": type(e).__name__}))
`;

let python = '';

function resolvePython(): string {
  const candidates = [
    process.env.YAML_PARITY_PYTHON,
    join(import.meta.dir, '..', '.venv', 'bin', 'python'),
    'python3',
    '/usr/bin/python3',
    'python',
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    try {
      const r = Bun.spawnSync([c, '-c', 'import yaml']);
      if (r.exitCode === 0) return c;
    } catch {
      // candidate not on PATH
    }
  }
  throw new Error(
    'No Python with PyYAML found (tried YAML_PARITY_PYTHON, plugin .venv, python3, /usr/bin/python3, python)',
  );
}

function pyTyped(text: string): { ok: boolean; data?: unknown; error?: string } {
  const r = Bun.spawnSync([python, '-c', PY_TYPED], { stdin: Buffer.from(text) });
  return JSON.parse(r.stdout.toString());
}

function tagBun(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(tagBun);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, tagBun(x)]),
    );
  }
  if (typeof v === 'boolean') return { t: 'bool', v };
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { t: 'float', v: 'nan' };
    if (v === Infinity) return { t: 'float', v: 'inf' };
    if (v === -Infinity) return { t: 'float', v: '-inf' };
    return Number.isInteger(v) ? { t: 'int', v } : { t: 'float', v };
  }
  if (typeof v === 'string') return { t: 'str', v };
  if (v === null) return { t: 'null', v: null };
  throw new Error(`unexpected parseYaml value of type ${typeof v}`);
}

beforeAll(() => {
  python = resolvePython();
});

// ---------------------------------------------------------------------------
// Corpus round-trip: parseYaml -> dumpYaml -> Python yaml.safe_load, deep
// equality with zero divergences. Includes adversarial-invalid-timestamp.yaml
// (the wrapper quotes 2024-13-45, so PyYAML no longer ValueErrors on it).
// Only adversarial-multidoc.yaml is excluded — parseYaml rejects it by
// design (dedicated test below).
// ---------------------------------------------------------------------------

const corpusFiles = readdirSync(CORPUS_DIR)
  .filter((f) => f.endsWith('.yaml'))
  .sort();

test('corpus is present', () => {
  expect(corpusFiles.length).toBeGreaterThanOrEqual(24);
  expect(corpusFiles).toContain('adversarial-multidoc.yaml');
});

describe('corpus: parseYaml -> dumpYaml -> python yaml.safe_load round-trip', () => {
  for (const file of corpusFiles) {
    if (file === 'adversarial-multidoc.yaml') continue;
    test(file, () => {
      const text = readFileSync(join(CORPUS_DIR, file), 'utf8');
      const parsed = parseYaml(text);
      const dumped = dumpYaml(parsed);
      const py = pyTyped(dumped);
      expect(py.ok).toBe(true);
      expect(py.data as never).toEqual(tagBun(parsed) as never);
      // and the dump re-reads identically through the wrapper itself
      expect(parseYaml(dumped) as never).toEqual(parsed as never);
    });
  }
});

// ---------------------------------------------------------------------------
// parseYaml: PyYAML safe_load strictness on document streams
// ---------------------------------------------------------------------------

describe('parseYaml multi-document rejection', () => {
  test('rejects the multidoc corpus file', () => {
    const text = readFileSync(join(CORPUS_DIR, 'adversarial-multidoc.yaml'), 'utf8');
    expect(() => parseYaml(text)).toThrow(/multi-document/);
  });

  test('rejects --- after content', () => {
    expect(() => parseYaml('a: 1\n---\nb: 2\n')).toThrow(/multi-document/);
  });

  test('rejects a trailing --- (PyYAML ComposerError parity)', () => {
    expect(() => parseYaml('a: 1\n---\n')).toThrow(/multi-document/);
  });

  test('rejects two document-start markers', () => {
    expect(() => parseYaml('---\n---\n')).toThrow(/multi-document/);
  });

  test('rejects content after a ... end marker (PyYAML ParserError parity)', () => {
    expect(() => parseYaml('a: 1\n...\nb: 2\n')).toThrow(/multi-document/);
  });

  test('accepts a single explicit document', () => {
    expect(parseYaml('---\na: 1\n') as never).toEqual({ a: 1 } as never);
  });

  test('accepts directives and comments before ---', () => {
    expect(parseYaml('%YAML 1.1\n# header\n---\na: 1\n') as never).toEqual({ a: 1 } as never);
  });

  test('accepts a document with a ... end marker and nothing after', () => {
    expect(parseYaml('a: 1\n...\n') as never).toEqual({ a: 1 } as never);
  });

  test('accepts an empty document as null (safe_load parity)', () => {
    expect(parseYaml('')).toBeNull();
    expect(parseYaml('# only a comment\n')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// dumpYaml: PyYAML 1.1 re-coercion quoting (the spike's gate-c failures)
// ---------------------------------------------------------------------------

describe('dumpYaml quoting of PyYAML-1.1-coercible strings', () => {
  test('sexagesimal strings are quoted', () => {
    expect(dumpYaml({ at: '10:30' })).toBe('at: "10:30"');
    expect(dumpYaml({ at: '1:02:03' })).toBe('at: "1:02:03"');
    expect(dumpYaml({ at: '1:02:03.5' })).toBe('at: "1:02:03.5"');
  });

  test('ISO date and datetime strings are quoted', () => {
    expect(dumpYaml({ created: '2024-01-01' })).toBe('created: "2024-01-01"');
    expect(dumpYaml({ created: '2026-06-11T08:30:00+00:00' })).toBe(
      'created: "2026-06-11T08:30:00+00:00"',
    );
    expect(dumpYaml({ created: '2024-01-01 10:00:00' })).toBe('created: "2024-01-01 10:00:00"');
    expect(dumpYaml({ created: '2024-01-01T10:00:00Z' })).toBe('created: "2024-01-01T10:00:00Z"');
  });

  test('underscored int strings are quoted; real numbers are not', () => {
    expect(dumpYaml({ n: '1_000' })).toBe('"n": "1_000"');
    expect(dumpYaml({ count: 1000 })).toBe('count: 1000');
    expect(dumpYaml({ pi: 3.14 })).toBe('pi: 3.14');
  });

  test('sequence items and nested mappings are processed', () => {
    // Bun 1.4.5 stopped emitting a trailing space after a key that opens a block.
    const dump = (value: unknown) => dumpYaml(value).replace(/ +$/gm, '');
    expect(dump({ l: ['10:30', '2024-01-01', 5] })).toBe(
      'l:\n  - "10:30"\n  - "2024-01-01"\n  - 5',
    );
    expect(dump({ triggers: [{ at: '7:15' }] })).toBe('triggers:\n  - at: "7:15"');
  });

  test('coercible KEYS are quoted too', () => {
    expect(dumpYaml({ '10:30': 'x' })).toBe('"10:30": x');
    expect(dumpYaml({ '2024-01-01': 'x' })).toBe('"2024-01-01": x');
  });

  test('non-coercible scalars pass through untouched', () => {
    expect(dumpYaml({ s: 'hello world' })).toBe('s: hello world');
    expect(dumpYaml({ s: 'light.kitchen' })).toBe('s: light.kitchen');
    expect(dumpYaml({ s: null })).toBe('s: null');
  });
});

describe('dumpYaml rejects JS Dates (Bun.YAML.stringify silently emits {})', () => {
  test('at the top level', () => {
    expect(() => dumpYaml({ created: new Date() })).toThrow(/Date/);
  });

  test('nested in arrays and objects', () => {
    expect(() => dumpYaml({ a: [{ b: new Date() }] })).toThrow(/Date/);
  });
});
