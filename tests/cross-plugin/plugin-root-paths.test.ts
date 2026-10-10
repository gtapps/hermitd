import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { walkFiles } from '../../plugins/hermitd/tests/helpers/run';

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
const PLUGINS = path.join(REPO_ROOT, 'plugins');
const RUNTIME_DOCS = ['hermitd/docs/artifacts.md'];
const TEACHING = 'Runnable plugin paths go only in SKILL.md or agent bodies as ${CLAUDE_PLUGIN_ROOT} (skills: Available string substitutions; plugins-reference: Where each variable resolves); other files refer to a command by name; the unbraced form is never substituted.';
type ReadKind = 'commands' | 'prose-only';
const CROSS_READERS: Record<string, Record<string, ReadKind>> = {
  'hermitd': {
    'hermit-settings -> channel-setup/references/group-enrollment.md': 'commands',
    'docker-setup -> channel-setup/references/group-enrollment.md': 'commands',
    'proposal-act -> watch/session-watch.md': 'commands',
    'task -> watch/session-watch.md': 'commands',
    'task -> proposal-act/reuse-spawned-helper.md': 'commands',
    'proposal-act -> watch/SKILL.md': 'prose-only',
    'hermit-evolve -> channel-responder/approvals.md': 'prose-only',
    'hermit-doctor -> channel-responder/outbound.md': 'commands',
    'spawn-session -> watch/session-watch.md': 'prose-only',
    'spawn-session -> watch/notices.md': 'prose-only',
    'proposal-create -> docs/artifacts.md': 'commands',
    'weekly-review -> docs/artifacts.md': 'commands',
    'proposal-act -> docs/artifacts.md': 'commands',
    'hermit-settings -> docs/artifacts.md': 'commands',
    'brief -> docs/artifacts.md': 'commands',
    'hermit-dashboard-design -> docs/artifacts.md': 'commands',
    'hermit-routines -> channel-responder/SKILL.md': 'prose-only',
    'task -> channel-responder/SKILL.md': 'prose-only',
    'docker-security -> hatch/SKILL.md': 'prose-only',
    'docker-setup -> hatch/SKILL.md': 'prose-only',
    'weekly-review -> spawn-session/SKILL.md': 'prose-only',
  },
};

const read = (file: string) => fs.readFileSync(file, 'utf8');
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function commands(file: string): Set<string> {
  const block = read(file).match(/^## Commands\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ?? '';
  const names = [...block.matchAll(/^- `([a-z0-9]+(?:-[a-z0-9]+)*)`: `[^`]+`\s*$/gm)].map((match) => match[1]);
  expect(new Set(names).size, `${file}: duplicate Commands names. ${TEACHING}`).toBe(names.length);
  return new Set(names);
}

for (const plugin of fs.readdirSync(PLUGINS)) {
  const root = path.join(PLUGINS, plugin);
  if (!fs.statSync(root).isDirectory()) continue;
  const skills = path.join(root, 'skills');
  const markdown = walkFiles(skills, (name) => name.endsWith('.md'));
  const docs = RUNTIME_DOCS.filter((file) => file.startsWith(`${plugin}/`)).map((file) => path.join(PLUGINS, file));
  const supporting = markdown.filter((file) => path.basename(file) !== 'SKILL.md').concat(docs);
  const pairs = new Map<string, string>();
  for (const source of markdown) {
    const reader = path.relative(skills, source).split(path.sep)[0];
    const body = read(source);
    const links = [...body.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)];
    for (const target of [...markdown, ...docs]) {
      const isDoc = docs.includes(target);
      const relative = path.relative(isDoc ? root : skills, target);
      if (!isDoc && relative.split(path.sep)[0] === reader) continue;
      // Covers skills-relative mentions, absolute plugin paths and ../ links.
      // Only real plugin markdown targets enter this candidate set.
      const mention = new RegExp(`(?<![\\w-])${escapeRe(relative)}(?![\\w./-])`);
      if (mention.test(body) || links.some((match) => path.resolve(path.dirname(source), match[1]) === target)) {
        pairs.set(`${reader} -> ${relative}`, target);
      }
    }
  }

  describe(`${plugin}: plugin-root paths`, () => {
    for (const file of walkFiles(path.join(root, 'state-templates'), () => true)) {
      test(`${path.relative(root, file)} has no installed root token`, () => {
        expect(read(file).match(/\$\{CLAUDE_PLUGIN_ROOT\}|<plugin_root>/g) ?? [], `${file}: root token. ${TEACHING}`).toEqual([]);
      });
    }
    for (const file of supporting) {
      test(`${path.relative(root, file)} uses Commands names`, () => {
        expect(read(file).match(/\$\{CLAUDE_PLUGIN_ROOT\}\//g) ?? [], `${file}: \${CLAUDE_PLUGIN_ROOT}/. ${TEACHING}`).toEqual([]);
        expect(read(file).includes('<plugin_root>'), `${file}: <plugin_root>. ${TEACHING}`).toBe(false);
      });
      test(`${path.relative(root, file)} Commands names resolve in every reader`, () => {
        const names = [...read(file).matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)*)` \(Commands\)/g)].map((match) => match[1]);
        const readers = new Set<string>();
        // Only evolve-runner reads hermit-evolve/reference.md; the skill just dispatches it.
        if (plugin === 'hermitd' && path.relative(skills, file) === 'hermit-evolve/reference.md') readers.add(path.join(root, 'agents/evolve-runner.md'));
        else if (!docs.includes(file)) readers.add(path.join(skills, path.relative(skills, file).split(path.sep)[0], 'SKILL.md'));
        for (const [pair, target] of pairs) {
          if (target === file && CROSS_READERS[plugin]?.[pair] === 'commands') readers.add(path.join(skills, pair.split(' -> ')[0], 'SKILL.md'));
        }
        for (const reader of readers) {
          const entries = commands(reader);
          for (const name of names) expect(entries.has(name), `${file}: ${name} (Commands) missing in ${reader}. ${TEACHING}`).toBe(true);
        }
      });
    }
    for (const file of [...markdown.filter((file) => path.basename(file) === 'SKILL.md'), ...walkFiles(path.join(root, 'agents'), (name) => name.endsWith('.md'))]) {
      test(`${path.relative(root, file)} braces plugin-root paths`, () => {
        expect(read(file).match(/(?<!\{)\$CLAUDE_PLUGIN_ROOT\//g) ?? [], `${file}: $CLAUDE_PLUGIN_ROOT/. ${TEACHING}`).toEqual([]);
      });
    }
    test('every cross-read is classified and every classification is current', () => {
      for (const [pair, target] of pairs) {
        const kind = CROSS_READERS[plugin]?.[pair];
        expect(kind, `${plugin}/${pair}: classify this cross-read; if the reader runs commands from it, mirror them in its Commands block. ${TEACHING}`).toBeDefined();
        if (path.basename(target) === 'SKILL.md') expect(kind, `${pair}: raw SKILL.md reads are not substituted. ${TEACHING}`).toBe('prose-only');
      }
      for (const pair of Object.keys(CROSS_READERS[plugin] ?? {})) expect(pairs.has(pair), `${plugin}/${pair}: stale cross-read classification. ${TEACHING}`).toBe(true);
    });
  });
}
