// messages.ts maintains state/messages.json, the operator-language copy of the
// script message catalog (lib/messages.ts). The model writes the language; these
// verbs own the syntax: keys, hashes, placeholder checks, and the file itself.
//
// Usage:
//   bun messages.ts scaffold <hermit-dir> <language>
//     Prints the keys that still need a translation into <language> (every key when
//     the file holds another language) with their English text and translator notes:
//     {"language":…,"todo":{key:{"en":…,"note"?:…}},"translated":N}.
//     English → {"status":"skipped","reason":"english"}.
//
//   bun messages.ts apply <hermit-dir>
//     Reads <hermit-dir>/state/messages-draft.json, {"language","locale","strings":{key:text}},
//     merges every valid entry into messages.json (a new language replaces the old
//     translations; overrides are never touched), then deletes the draft. Prints
//     {"status":"ok","applied":N,"rejected":[keys],"missing":[keys]}, plus
//     "locale_rejected":true when the draft's locale is not a BCP 47 tag Intl knows.
//     A draft whose language is not config.language → {"status":"rejected","reason":"language_mismatch"}.
//
//   bun messages.ts clear <hermit-dir>
//     Drops the translations (English operator); keeps overrides. Prints OK.
//
//   bun messages.ts list <hermit-dir>
//     Every key with its English text and any operator override, for picking the
//     key an operator wants reworded.
//
//   bun messages.ts set <hermit-dir> <key> <text>
//     Records an operator override. OK, or {"status":"rejected","reason":"unknown_key"|
//     "placeholder_mismatch","expected":[…]} when the text can't stand in for the key.
//
//   bun messages.ts reset <hermit-dir> <key|--all>
//     Removes one override, or all of them. Prints OK.
//
//   bun messages.ts status <hermit-dir>
//     Per-key health against config.language and the shipped English.

import fs from 'node:fs';
import path from 'node:path';
import {
  EN, NOTES, enHash, isEnglish, isMessageKey, validLocale, validText, expectedPlaceholders, sameLanguage, auditMessages,
  readMessagesFile, messagesPath, type MessageKey,
} from './lib/messages';
import { readSettledConfig } from './lib/config-read';
import { writeFileAtomic } from './lib/md-write';
import { emit, emitJson, exitError, readJson } from './lib/cli';

type Json = any;

const ALL_KEYS = Object.keys(EN) as MessageKey[];

function draftPath(dir: string): string {
  return path.join(dir, 'state', 'messages-draft.json');
}

function load(dir: string): Json {
  const f = readMessagesFile(dir) ?? {};
  if (!f.strings || typeof f.strings !== 'object') f.strings = {};
  if (!f.overrides || typeof f.overrides !== 'object') f.overrides = {};
  return f;
}

function save(dir: string, f: Json): void {
  const hasStrings = Object.keys(f.strings).length > 0;
  const hasOverrides = Object.keys(f.overrides).length > 0;
  if (!hasStrings && !hasOverrides) {
    fs.rmSync(messagesPath(dir), { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(messagesPath(dir)), { recursive: true });
  const out: Json = {};
  if (hasStrings) Object.assign(out, { language: f.language, locale: f.locale ?? null, strings: f.strings });
  out.overrides = f.overrides;
  writeFileAtomic(messagesPath(dir), JSON.stringify(out, null, 2) + '\n');
}

function configLanguage(dir: string): unknown {
  try { return readSettledConfig(dir)?.language; } catch { return null; }
}

function verbScaffold(dir: string, language: string): never {
  if (isEnglish(language)) emitJson({ status: 'skipped', reason: 'english' });
  const audit = auditMessages(readMessagesFile(dir), language);
  const todo: Record<string, Json> = {};
  for (const key of ALL_KEYS) {
    if (audit.translated.includes(key)) continue;
    todo[key] = NOTES[key] ? { en: EN[key], note: NOTES[key] } : { en: EN[key] };
  }
  emitJson({ language, todo, translated: audit.translated.length });
}

function verbApply(dir: string): never {
  const draft = readJson(draftPath(dir));
  if (!draft || typeof draft.language !== 'string' || !draft.strings || typeof draft.strings !== 'object') {
    exitError('invalid_draft');
  }
  if (isEnglish(draft.language)) exitError('invalid_draft:english');
  // A draft for any other spelling than config.language would be saved and then
  // never match at send time, so it is turned away here instead.
  if (!sameLanguage(draft.language, configLanguage(dir))) emitJson({ status: 'rejected', reason: 'language_mismatch' });
  const f = load(dir);
  if (!sameLanguage(f.language, draft.language)) { f.strings = {}; f.locale = null; }
  f.language = draft.language;
  const locale = validLocale(draft.locale);
  if (locale) f.locale = locale;
  let applied = 0;
  const rejected: string[] = [];
  for (const [key, text] of Object.entries(draft.strings)) {
    if (!isMessageKey(key) || !validText(key, text)) { rejected.push(key); continue; }
    f.strings[key] = { text, en_hash: enHash(key) };
    applied++;
  }
  save(dir, f);
  fs.rmSync(draftPath(dir), { force: true });
  const audit = auditMessages(f, draft.language);
  emitJson({
    status: 'ok', applied, rejected, missing: [...audit.missing, ...audit.stale, ...audit.invalid],
    ...(draft.locale != null && !locale ? { locale_rejected: true } : {}),
  });
}

function verbClear(dir: string): never {
  const f = load(dir);
  f.strings = {};
  save(dir, f);
  emit('OK');
}

function verbList(dir: string): never {
  const overrides = load(dir).overrides;
  emitJson({
    keys: ALL_KEYS.map((key) => (overrides[key] === undefined ? { key, en: EN[key] } : { key, en: EN[key], override: overrides[key] })),
  });
}

function verbSet(dir: string, key: string, text: string | undefined): never {
  if (text === undefined) exitError();
  if (!isMessageKey(key)) emitJson({ status: 'rejected', reason: 'unknown_key' });
  if (!validText(key, text)) emitJson({ status: 'rejected', reason: 'placeholder_mismatch', expected: expectedPlaceholders(key).map((p) => `{${p}}`) });
  const f = load(dir);
  f.overrides[key] = text;
  save(dir, f);
  emit('OK');
}

function verbReset(dir: string, key: string): never {
  const f = load(dir);
  if (key === '--all') f.overrides = {};
  else delete f.overrides[key];
  save(dir, f);
  emit('OK');
}

function verbStatus(dir: string): never {
  const language = configLanguage(dir);
  const file = readMessagesFile(dir);
  const a = auditMessages(file, language);
  emitJson({
    language: language ?? null,
    file_language: file?.language ?? null,
    translated: a.translated.length,
    stale: a.stale,
    invalid: a.invalid,
    missing: a.missing.length,
    overrides: a.overridden,
    invalid_overrides: a.invalidOverrides,
  });
}

const [verb, dir, ...rest] = process.argv.slice(2);
if (!dir) exitError();
switch (verb) {
  case 'scaffold': if (!rest[0]) exitError(); verbScaffold(dir, rest[0]); break;
  case 'apply': verbApply(dir); break;
  case 'clear': verbClear(dir); break;
  case 'list': verbList(dir); break;
  case 'set': verbSet(dir, rest[0] ?? '', rest[1]); break;
  case 'reset': if (!rest[0]) exitError(); verbReset(dir, rest[0]); break;
  case 'status': verbStatus(dir); break;
  default: exitError();
}
