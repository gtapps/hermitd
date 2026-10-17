import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-voice-render-');
afterAll(cleanup);

const VOICE_FILE = path.join('.claude', 'output-styles', 'hermit-voice.md');

/** A project with a settings file and a hermit config — what the op reads and writes. */
function project(opts: { settings?: any; voice?: any; settingsName?: string } = {}): {
  dir: string;
  settingsFile: string;
  voiceFile: string;
} {
  const dir = freshDir();
  const claude = path.join(dir, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  const settingsFile = path.join(claude, opts.settingsName ?? 'settings.local.json');
  fs.writeFileSync(settingsFile, JSON.stringify(opts.settings ?? {}, null, 2) + '\n');

  const hermit = path.join(dir, '.hermit');
  fs.mkdirSync(hermit, { recursive: true });
  const config: any = { agent_name: 'Atlas' };
  if (opts.voice !== undefined) config.voice = opts.voice;
  fs.writeFileSync(path.join(hermit, 'config.json'), JSON.stringify(config, null, 2) + '\n');

  return { dir, settingsFile, voiceFile: path.join(dir, VOICE_FILE) };
}

const readSettings = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
const readRaw = (f: string) => fs.readFileSync(f, 'utf8');

const render = (settingsFile: string) =>
  runScript('apply-settings.ts', { args: [settingsFile, 'voice-render'] });

// config.json owns the voice; this op is its render. The invariants that matter:
// an unset style is not the hermit's key to touch, `custom` reproduces the
// operator's words byte-for-byte, and the render is unconditional otherwise —
// boot re-runs it every start, so it must converge, not accumulate.
describe('apply-settings.ts voice-render', () => {
  test('renders a built-in style into outputStyle and writes no file', async () => {
    const { settingsFile, voiceFile } = project({ voice: { style: 'Concise', prose: null } });
    const r = await render(settingsFile);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ status: 'applied', style: 'Concise' });
    expect(readSettings(settingsFile).outputStyle).toBeUndefined();
    expect(fs.existsSync(voiceFile)).toBe(false);
  });

  test('"default" is written lowercase, as Claude Code persists it', async () => {
    const { settingsFile } = project({ voice: { style: 'default', prose: null } });
    await render(settingsFile);
    expect(readSettings(settingsFile).outputStyle).toBeUndefined();
  });

  test('custom renders the prose verbatim and points the key at the file', async () => {
    const prose = 'Lead with the answer.\n\nNo preamble. Keep `code` in backticks — even "quoted" bits.';
    const { settingsFile, voiceFile } = project({ voice: { style: 'custom', prose } });
    const r = await render(settingsFile);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ status: 'applied', style: 'hermit-voice' });
    expect(readSettings(settingsFile).outputStyle).toBeUndefined();
    const body = readRaw(voiceFile);
    expect(body).toContain(prose);
    expect(body).toContain('name: hermit-voice');
    expect(body).toContain('## Precedence');
    expect(body).not.toContain('{{VOICE_PROSE}}');
  });

  // Verbatim means verbatim: a string replacement expands `$&`, "$`", "$'" and
  // `$1` in the replacement, which would paste the placeholder back into the voice.
  test('prose carrying $-sequences renders untouched', async () => {
    const prose = 'Quote sums as $\'000s. Never expand $& or $1 or $` in examples.';
    const { settingsFile, voiceFile } = project({ voice: { style: 'custom', prose } });
    const r = await render(settingsFile);
    expect(r.exitCode).toBe(0);
    expect(readRaw(voiceFile)).toContain(prose);
    expect(readRaw(voiceFile)).not.toContain('{{VOICE_PROSE}}');
  });

  test('an unset style writes nothing — the operator\'s own /config pick is theirs', async () => {
    const { settingsFile } = project({
      settings: { outputStyle: 'Explanatory' },
      voice: { style: null, prose: null },
    });
    const before = readRaw(settingsFile);
    const r = await render(settingsFile);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ status: 'skipped', reason: 'unset' });
    expect(readRaw(settingsFile)).toBe(before); // byte-identical: boot runs this every start
  });

  test('a missing voice block is the same as an unset style', async () => {
    const { settingsFile } = project({});
    const r = await render(settingsFile);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ status: 'skipped', reason: 'unset' });
    expect(readSettings(settingsFile).outputStyle).toBeUndefined();
  });

  test('a configured style replaces a different persisted one — config is the truth', async () => {
    const { settingsFile } = project({
      settings: { outputStyle: 'Explanatory' },
      voice: { style: 'Concise', prose: null },
    });
    await render(settingsFile);
    expect(readSettings(settingsFile).outputStyle).toBe('Explanatory');
  });

  test('custom with empty prose fails loudly rather than rendering an empty voice', async () => {
    const { settingsFile, voiceFile } = project({ voice: { style: 'custom', prose: '   ' } });
    const r = await render(settingsFile);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: 'voice_prose_empty' });
    expect(fs.existsSync(voiceFile)).toBe(false);
    expect(readSettings(settingsFile).outputStyle).toBeUndefined();
  });

  test('refuses a target that is not settings.local.json', async () => {
    const { settingsFile } = project({
      settingsName: 'settings.json',
      voice: { style: 'custom', prose: 'Short answers.' },
    });
    const r = await render(settingsFile);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: 'not_settings_local' });
    expect(readSettings(settingsFile).outputStyle).toBeUndefined();
  });

  test('preserves every sibling key in the settings file', async () => {
    const { settingsFile } = project({
      settings: { permissions: { allow: ['Bash(ls:*)'] }, env: { FOO: 'bar' } },
      voice: { style: 'Concise', prose: null },
    });
    await render(settingsFile);
    const s = readSettings(settingsFile);
    expect(s.permissions.allow).toEqual(['Bash(ls:*)']);
    expect(s.env).toEqual({ FOO: 'bar' });
    expect(s.outputStyle).toBeUndefined();
  });

  test('re-running converges: same bytes, and a hand-edited voice file is restored', async () => {
    const prose = 'Short answers. Show the command.';
    const { settingsFile, voiceFile } = project({ voice: { style: 'custom', prose } });
    await render(settingsFile);
    const first = readRaw(voiceFile);
    fs.writeFileSync(voiceFile, 'hand-edited, not from config\n');
    await render(settingsFile);
    // config.json is the truth — the file is its render, so an out-of-band edit
    // does not survive the next boot. hermit-settings voice is the edit path.
    expect(readRaw(voiceFile)).toBe(first);
  });

  test('does not record a settings write for style rendering', async () => {
    const { dir, settingsFile } = project({ voice: { style: 'Concise', prose: null } });
    await render(settingsFile);
    const ledger = path.join(dir, '.hermit', 'state', 'settings-audit.jsonl');
    expect(fs.existsSync(ledger)).toBe(false);
  });
});
