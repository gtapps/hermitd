import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { browserDeployment, browserDataDir, browserProfile, browserEnabled, browserSocketDir, dockerfileHasOwnBrowser } from '../scripts/lib/browser-runtime';
import { render } from '../scripts/render-docker-templates';
import { registerProject } from '../scripts/lib/host-registry';
import { freshDirFactory } from './helpers/workdir';
const { freshDir, cleanup } = freshDirFactory('browser-runtime-');
afterAll(cleanup);

test('Compose identifies a Docker deployment regardless of runtime mode', () => {
  const project = freshDir();
  const dir = path.join(project, '.hermit');
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  expect(browserDeployment(dir, true)).toBe('container');
  expect(browserDeployment(dir, false)).toBe('host');
  fs.writeFileSync(path.join(project, 'docker-compose.hermit.yml'), 'services: {}');
  expect(browserDeployment(dir, false)).toBe('docker_host');
  fs.writeFileSync(path.join(dir, 'state/runtime.json'), JSON.stringify({ runtime_mode: 'tmux' }));
  expect(browserDeployment(dir, false)).toBe('docker_host');
  expect(browserProfile(dir, 'host')).toBe(path.join(fs.realpathSync(project), '.claude.local/browser/profile'));
  expect(browserProfile(dir, 'docker_host')).toBe('/home/claude/.claude/browser/profile');
  expect(browserEnabled(dir)).toBe(true);
  fs.writeFileSync(path.join(dir, 'config.json'), '{"browser":{"enabled":false}}');
  expect(browserEnabled(dir)).toBe(false);
  expect(browserSocketDir(dir)).not.toBe(browserSocketDir(dir + '-other'));
  expect(browserDataDir('/local/plugins/hermitd')).toEndWith('/hermitd-inline/browser');
  expect(browserDataDir('/marketplaces/example/plugins/hermitd')).toEndWith('/hermitd-example/browser');
});
test('a registry row identifies a Docker deployment without Compose', () => {
  const project = fs.realpathSync(freshDir());
  const dir = path.join(project, '.hermit');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  const root = path.join(project, 'cache/mp/hermitd/1');
  const previous = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = path.join(project, 'plugins');
  try {
    registerProject(project, root, 'docker');
    expect(browserDeployment(dir, false, root)).toBe('docker_host');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
    else process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = previous;
  }
});

test('only operator browser installations count as a conflict', () => {
  const file = path.join(freshDir(), 'Dockerfile.hermit');
  expect(dockerfileHasOwnBrowser(file)).toBe(false);
  fs.writeFileSync(file, '# Managed browser (pins)\nRUN npm install agent-browser \\\n  && touch /etc/hermit/managed-browser\n');
  expect(dockerfileHasOwnBrowser(file)).toBe(false);
  fs.appendFileSync(file, 'RUN npm install agent-browser\n');
  expect(dockerfileHasOwnBrowser(file)).toBe(true);
});

test('delimited managed browser is excluded while operator installs remain visible', () => {
  const file = path.join(freshDir(), 'Dockerfile.hermit');
  const { dockerfile } = render({ networkMode: 'bridge', gitIdentityMount: true });
  fs.writeFileSync(file, dockerfile);
  expect(dockerfileHasOwnBrowser(file)).toBe(false);
  fs.appendFileSync(file, '\nRUN npm install agent-browser\n');
  expect(dockerfileHasOwnBrowser(file)).toBe(true);
  fs.writeFileSync(file, 'RUN npm install agent-browser\n' + dockerfile);
  expect(dockerfileHasOwnBrowser(file)).toBe(true);
});
