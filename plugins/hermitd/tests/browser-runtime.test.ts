import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { browserDeployment, browserDataDir, browserProfile, browserEnabled, browserSocketDir, dockerfileHasOwnBrowser } from '../scripts/lib/browser-runtime';
import { freshDirFactory } from './helpers/workdir';
const { freshDir, cleanup } = freshDirFactory('browser-runtime-');
afterAll(cleanup);

test('runtime mode disambiguates host and Docker deployments', () => {
  const project = freshDir();
  const dir = path.join(project, '.hermit');
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  expect(browserDeployment(dir, true)).toBe('container');
  expect(browserDeployment(dir, false)).toBe('host');
  fs.writeFileSync(path.join(project, 'docker-compose.hermit.yml'), 'services: {}');
  expect(browserDeployment(dir, false)).toBe('docker_host');
  fs.writeFileSync(path.join(dir, 'state/runtime.json'), JSON.stringify({ runtime_mode: 'tmux' }));
  expect(browserDeployment(dir, false)).toBe('host');
  expect(browserProfile(dir, 'host')).toBe(path.join(fs.realpathSync(project), '.claude.local/browser/profile'));
  expect(browserProfile(dir, 'docker_host')).toBe('/home/claude/.claude/browser/profile');
  expect(browserEnabled(dir)).toBe(true);
  fs.writeFileSync(path.join(dir, 'config.json'), '{"browser":{"enabled":false}}');
  expect(browserEnabled(dir)).toBe(false);
  expect(browserSocketDir(dir)).not.toBe(browserSocketDir(dir + '-other'));
  expect(browserDataDir('/local/plugins/hermitd')).toEndWith('/hermitd-inline/browser');
  expect(browserDataDir('/marketplaces/example/plugins/hermitd')).toEndWith('/hermitd-example/browser');
});

test('only operator browser installations count as a conflict', () => {
  const file = path.join(freshDir(), 'Dockerfile.hermit');
  expect(dockerfileHasOwnBrowser(file)).toBe(false);
  fs.writeFileSync(file, '# Managed browser (pins)\nRUN npm install agent-browser \\\n  && touch /etc/hermit/managed-browser\n');
  expect(dockerfileHasOwnBrowser(file)).toBe(false);
  fs.appendFileSync(file, 'RUN npm install agent-browser\n');
  expect(dockerfileHasOwnBrowser(file)).toBe(true);
});
