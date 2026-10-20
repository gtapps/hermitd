import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT } from './helpers/run';
import { frontmatterBlock } from './helpers/skill-frontmatter';

test('native monitors start only on the namespaced activation skill', () => {
  const monitors = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'monitors/monitors.json'), 'utf-8'));
  expect(monitors).toHaveLength(3);
  expect(monitors.map((monitor: { name: string }) => monitor.name).sort()).toEqual([
    'heartbeat-monitor', 'routine-monitor', 'watch-monitor',
  ]);
  for (const monitor of monitors) {
    expect(monitor.when).toBe(`on-skill-invoke:hermitd:${monitor.name === 'watch-monitor' ? 'watch-activate' : 'monitor-activate'}`);
    const leg = monitor.name === 'heartbeat-monitor' ? 'heartbeat' : monitor.name === 'watch-monitor' ? 'watches' : 'routines';
    expect(monitor.command).toBe(`bash "${'${CLAUDE_PLUGIN_ROOT}'}"/scripts/monitor-supervisor.sh ${leg} "${'${CLAUDE_PROJECT_DIR}'}"/.hermit`);
  }
  const skill = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/monitor-activate/SKILL.md'), 'utf-8');
  expect(frontmatterBlock(skill)).toMatch(/^name: monitor-activate$/m);
});

test('watch activation skill has its own name', () => {
  const skill = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/watch-activate/SKILL.md'), 'utf-8');
  expect(frontmatterBlock(skill)).toMatch(/^name: watch-activate$/m);
});
