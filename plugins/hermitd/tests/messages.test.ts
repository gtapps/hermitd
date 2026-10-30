// Unit tests for scripts/lib/messages.ts (the operator-facing message catalog and
// its state/messages.json overlay) and scripts/messages.ts (the CLI that writes
// it). Byte-identity of the English bodies is a separate regression guard
// (tests/localization-regression.test.ts).

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  EN, NOTES, LOCKED, EN_MESSAGES, buildMessages, loadMessages, friendlyDate, enHash, validText,
  auditMessages, messagesPath, type MessageKey,
} from '../scripts/lib/messages';

const CLI = path.join(import.meta.dir, '..', 'scripts', 'messages.ts');

const entry = (key: MessageKey, text: string) => ({ text, en_hash: enHash(key) });

describe('catalog shape', () => {
  test('every key has non-empty English text', () => {
    for (const [key, text] of Object.entries(EN)) expect(text.trim().length, key).toBeGreaterThan(0);
  });

  test('notes only name real keys', () => {
    for (const key of Object.keys(NOTES)) expect(key in EN, key).toBe(true);
  });

  test('locked tokens are placeholders, never English prose', () => {
    expect(EN.mint_ack_prompt).toContain("'{keyword}'");
    expect(EN.mint_ack_prompt).not.toContain('reauth');
    expect(EN.watchdog_api_unavailable).toContain('{url}');
    expect(EN.watchdog_orphan).toContain('{command}');
  });
});

describe('validText', () => {
  test('requires the exact English placeholder set', () => {
    expect(validText('watchdog_wedge', 'Sin respuesta ({time}).')).toBe(true);
    expect(validText('watchdog_wedge', 'Sin respuesta.')).toBe(false);
    expect(validText('watchdog_wedge', 'Sin respuesta ({hora}).')).toBe(false);
    expect(validText('watchdog_wedge', 'Sin ({time}) {extra}.')).toBe(false);
    expect(validText('mint_ack_prompt', "Responda 'reauth'.")).toBe(false);
    expect(validText('status_idle', '   ')).toBe(false);
    expect(validText('status_idle', 42)).toBe(false);
  });
});

describe('buildMessages resolution', () => {
  const file = {
    language: 'es',
    locale: 'es-ES',
    strings: {
      watchdog_wedge: entry('watchdog_wedge', 'Tu agente no responde ({time}).'),
      status_idle: entry('status_idle', 'Inactivo.'),
      status_working: { text: 'Trabajando.', en_hash: 'stale0000000' },
      watchdog_wedge_recovered: entry('watchdog_wedge_recovered', 'Responde de nuevo.'),
      budget_heads_up_prefix: entry('budget_heads_up_prefix', 'Atención —'),
    },
    overrides: { status_idle: 'Descansando.', status_all_quiet: 'Nada que contar {oops}' },
  };

  test('translation applies when the language matches', () => {
    expect(buildMessages(file, 'es').t('watchdog_wedge', { time: '08:30' })).toBe('Tu agente no responde (08:30).');
    expect(buildMessages(file, ' ES ').t('watchdog_wedge', { time: '1' })).toBe('Tu agente no responde (1).');
  });

  test('override wins over translation', () => {
    expect(buildMessages(file, 'es').t('status_idle')).toBe('Descansando.');
  });

  test('stale hash falls back to English for that key only', () => {
    const m = buildMessages(file, 'es');
    expect(m.t('status_working')).toBe('Working.');
    expect(m.t('watchdog_wedge', { time: 'x' })).toContain('Tu agente');
  });

  test('a translation that lost a placeholder falls back to English', () => {
    expect(buildMessages(file, 'es').t('watchdog_wedge_recovered', { time: '08:30' }))
      .toBe('Your agent is responding again, nothing to do (08:30).');
  });

  test('an override with the wrong placeholders falls back', () => {
    expect(buildMessages(file, 'es').t('status_all_quiet')).toBe(EN.status_all_quiet);
  });

  test('English edge whitespace is kept for joined fragments', () => {
    expect(buildMessages(file, 'es').t('budget_heads_up_prefix')).toBe('Atención — ');
  });

  test('language mismatch ignores translations but keeps overrides', () => {
    const m = buildMessages(file, 'fr');
    expect(m.t('watchdog_wedge', { time: 't' })).toBe(EN.watchdog_wedge.replace('{time}', 't'));
    expect(m.t('status_idle')).toBe('Descansando.');
    expect(m.locale).toBe('en-GB');
  });

  test('English operators get overrides from an overrides-only file', () => {
    const m = buildMessages({ overrides: { status_idle: 'Resting.' } }, null);
    expect(m.t('status_idle')).toBe('Resting.');
    expect(m.t('status_working')).toBe('Working.');
  });

  test('missing or malformed files mean English', () => {
    for (const f of [null, {}, { language: 'es', strings: 'x' }, { language: 'es', strings: { status_idle: 'raw' } }]) {
      expect(buildMessages(f, 'es').t('status_idle')).toBe('Idle.');
    }
  });

  test('unknown vars leave the token; values are not rescanned', () => {
    expect(EN_MESSAGES.t('status_working_on', {})).toBe('Working on {task}.');
    expect(EN_MESSAGES.t('status_working_on', { task: '{id}' })).toBe('Working on {id}.');
  });
});

describe('friendlyDate', () => {
  const ISO = '2026-07-05T12:00:00Z';

  test('English keeps the en-GB long form', () => {
    expect(friendlyDate(EN_MESSAGES, ISO)).toBe('5 July 2026');
  });

  test('a valid file locale formats in that language', () => {
    const m = buildMessages({ language: 'pt', locale: 'pt-PT', strings: {} }, 'pt');
    expect(friendlyDate(m, ISO)).toBe('5 de julho de 2026');
  });

  test('an invalid locale tag falls back to en-GB', () => {
    const m = buildMessages({ language: 'Portuguese', locale: 'Portuguese', strings: {} }, 'Portuguese');
    expect(m.locale).toBe('en-GB');
    expect(friendlyDate(m, ISO)).toBe('5 July 2026');
  });

  test('invalid input uses the unknown-date wording', () => {
    expect(friendlyDate(EN_MESSAGES, 'not-a-date')).toBe('in about a year');
  });
});

describe('messages.ts CLI', () => {
  let dir: string;
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    const out = r.stdout.trim();
    return { code: r.status, out, json: out.startsWith('{') ? JSON.parse(out) : null };
  };
  const writeDraft = (draft: object) =>
    fs.writeFileSync(path.join(dir, 'state', 'messages-draft.json'), JSON.stringify(draft));
  const file = () => JSON.parse(fs.readFileSync(messagesPath(dir), 'utf8'));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-messages-'));
    fs.mkdirSync(path.join(dir, 'state'));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ language: 'es' }));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('scaffold lists every key with notes, English skips', () => {
    const r = run('scaffold', dir, 'es');
    expect(r.code).toBe(0);
    expect(Object.keys(r.json.todo).length).toBe(Object.keys(EN).length);
    expect(r.json.todo.mint_ack_prompt.note).toContain('{keyword}');
    expect(run('scaffold', dir, 'en').json).toEqual({ status: 'skipped', reason: 'english' });
  });

  test('apply merges valid entries, rejects bad ones, deletes the draft', () => {
    writeDraft({ language: 'es', locale: 'es-ES', strings: {
      watchdog_wedge: 'Sin respuesta ({time}).', status_idle: 'Inactivo.', watchdog_wedge_recovered: 'Ok.', nope: 'x',
    } });
    const r = run('apply', dir);
    expect(r.code).toBe(0);
    expect(r.json.applied).toBe(2);
    expect(r.json.rejected.sort()).toEqual(['nope', 'watchdog_wedge_recovered']);
    expect(fs.existsSync(path.join(dir, 'state', 'messages-draft.json'))).toBe(false);
    expect(file().strings.status_idle).toEqual({ text: 'Inactivo.', en_hash: enHash('status_idle') });
    expect(loadMessages(dir, 'es').t('watchdog_wedge', { time: '9' })).toBe('Sin respuesta (9).');
    // A second scaffold only asks for what is still untranslated.
    expect(run('scaffold', dir, 'es').json.todo.status_idle).toBeUndefined();
  });

  test('a stale key reappears in scaffold and a corrupt file reads as English', () => {
    fs.writeFileSync(messagesPath(dir), JSON.stringify({ language: 'es', strings: {
      status_idle: { text: 'Inactivo.', en_hash: 'old000000000' },
    } }));
    expect(run('scaffold', dir, 'es').json.todo.status_idle).toBeDefined();
    fs.writeFileSync(messagesPath(dir), '{not json');
    expect(loadMessages(dir, 'es').t('status_idle')).toBe('Idle.');
  });

  test('set/reset manage overrides, which survive a new language and apply', () => {
    expect(run('set', dir, 'status_idle', 'Descansando.').out).toBe('OK');
    expect(run('set', dir, 'watchdog_wedge', 'Sin respuesta.').json)
      .toEqual({ status: 'rejected', reason: 'placeholder_mismatch', expected: ['{time}'] });
    expect(run('set', dir, 'no_such_key', 'x').json).toEqual({ status: 'rejected', reason: 'unknown_key' });

    writeDraft({ language: 'fr', locale: 'fr-FR', strings: { status_working: 'Au travail.' } });
    run('apply', dir);
    expect(file().overrides).toEqual({ status_idle: 'Descansando.' });
    expect(file().language).toBe('fr');

    const list = run('list', dir).json.keys;
    expect(list.find((k: any) => k.key === 'status_idle').override).toBe('Descansando.');

    expect(run('reset', dir, 'status_idle').out).toBe('OK');
    expect(file().overrides).toEqual({});
  });

  test('clear drops translations, keeps overrides, removes an empty file', () => {
    writeDraft({ language: 'es', strings: { status_idle: 'Inactivo.' } });
    run('apply', dir);
    run('set', dir, 'status_working', 'Busy.');
    expect(run('clear', dir).out).toBe('OK');
    expect(file()).toEqual({ overrides: { status_working: 'Busy.' } });
    run('reset', dir, '--all');
    expect(fs.existsSync(messagesPath(dir))).toBe(false);
  });

  test('status reports per-key health against config.language', () => {
    fs.writeFileSync(messagesPath(dir), JSON.stringify({
      language: 'es',
      strings: { status_idle: entry('status_idle', 'Inactivo.'), status_working: { text: 'T.', en_hash: 'x' } },
      overrides: { watchdog_wedge: 'No {time}', status_all_quiet: 'Bad {x}' },
    }));
    const s = run('status', dir).json;
    expect(s.translated).toBe(1);
    expect(s.stale).toEqual(['status_working']);
    expect(s.overrides).toEqual(['watchdog_wedge']);
    expect(s.invalid_overrides).toEqual(['status_all_quiet']);
    expect(auditMessages(JSON.parse(fs.readFileSync(messagesPath(dir), 'utf8')), 'fr').live).toBe(false);
  });
});

test('LOCKED values are the literals the senders and matchers depend on', () => {
  expect(LOCKED.keyword).toBe('reauth');
  expect(LOCKED.status_url).toBe('https://status.claude.com');
});
