// Drift guard for the copies of live text that eval cases under evals/ carry.
// Session-start context comes from the real startup-context.ts hook in an eval
// run, so only the text no hook can produce there is copied into a case:
//   - an agent body, or the resident prompt hermitd-start appends at launch,
//     passed as `append_system_prompt` (the generators write it);
//   - the channel reply reminder and responder nudge, because hermitd's mod
//     drops a prompt submitted as a bare <channel> envelope from a non-channel
//     origin, so the UserPromptSubmit pipeline never runs on an eval prompt.
// A failure here means a case is stale: rerun its generator, or update the
// hand-written case, in the same change as the live text.
//
// Usage: bun test tests/evals-drift.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { readFileWithFrontmatter } from '../scripts/lib/frontmatter';
import { buildResidentPrompt } from '../scripts/lib/resident-prompt';
import { PLUGIN_ROOT, runScript, walkFiles } from './helpers/run';
import { setupWorkdir } from './helpers/workdir';

const EVALS = path.join(PLUGIN_ROOT, 'evals');

interface Case { file: string; prompt: string; appendSystemPrompt?: string }

const CASES: Case[] = walkFiles(EVALS, n => n === 'case.yaml', new Set(['results'])).sort().map(p => {
  const doc = Bun.YAML.parse(fs.readFileSync(p, 'utf-8')) as { execution?: { prompt?: string; append_system_prompt?: string } };
  return { file: path.relative(EVALS, p), prompt: doc.execution?.prompt ?? '', appendSystemPrompt: doc.execution?.append_system_prompt };
});

describe('eval case copies of live text', () => {
  test('every append_system_prompt is a shipped agent body or the shipped resident prompt', () => {
    const agentsDir = path.join(PLUGIN_ROOT, 'agents');
    const bodies = fs.readdirSync(agentsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => readFileWithFrontmatter(path.join(agentsDir, f))!.body.trim());
    bodies.push(buildResidentPrompt('/nonexistent-project').trim());
    const withBody = CASES.filter(c => c.appendSystemPrompt !== undefined);
    expect(withBody.length).toBeGreaterThan(0);
    const stale = withBody.filter(c => !bodies.includes(c.appendSystemPrompt!.trim())).map(c => c.file);
    expect(stale).toEqual([]);
  });

  test('channel reminder and nudge in every channel case match the UserPromptSubmit pipeline', async () => {
    const routed = CASES.filter(c => c.prompt.includes('<channel '));
    expect(routed.length).toBeGreaterThan(0);
    // Each case gets its own workdir, so the pipeline runs are independent; batch them so a
    // loaded host running other suites does not get dozens of bun processes at once.
    const check = async (c: Case): Promise<string[]> => {
      const envelope = c.prompt.match(/<channel [\s\S]*?<\/channel>/)?.[0];
      const userId = envelope?.match(/user_id="(\d+)"/)?.[1];
      if (!envelope || !userId) return [`${c.file}: no channel envelope`];
      const wd = setupWorkdir();
      try {
        fs.writeFileSync(path.join(wd.dir, '.hermit', 'config.json'),
          JSON.stringify({ channels: { discord: { allowed_users: [userId] } } }));
        const r = await runScript('user-prompt-pipeline.ts', { stdin: JSON.stringify({ prompt: envelope }), cwd: wd.dir });
        const lines = r.stdout.split('\n');
        const reminder = lines.find(l => l.startsWith('[channel reply reminder]'));
        const nudge = lines.find(l => l.startsWith('Handle it with the channel-responder skill'));
        const out: string[] = [];
        if (!reminder || !c.prompt.includes(reminder)) out.push(`${c.file}: reminder`);
        // Paused and harness-command cases carry no nudge by design; when a case has one it must be current.
        if (c.prompt.includes('Handle it with the channel-responder skill') && (!nudge || !c.prompt.includes(nudge))) {
          out.push(`${c.file}: nudge`);
        }
        return out;
      } finally {
        wd.cleanup();
      }
    };
    const problems: string[][] = [];
    for (let i = 0; i < routed.length; i += 8) problems.push(...await Promise.all(routed.slice(i, i + 8).map(check)));
    expect(problems.flat()).toEqual([]);
  }, 60_000);
});
