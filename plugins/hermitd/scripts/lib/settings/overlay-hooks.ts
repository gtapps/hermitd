import path from 'node:path';

export function overlayHooks(pluginRoot: string) {
  return {
    PreToolUse: [
      {
        matcher: '*',
        hooks: [{
          type: 'command',
          command: 'bun',
          args: ['--no-install', path.resolve(pluginRoot, 'scripts', 'pause-gate.ts')],
          timeout: 3,
        }],
      },
      {
        matcher: 'AskUserQuestion',
        hooks: [{
          type: 'command',
          command: 'bun',
          args: ['--no-install', path.resolve(pluginRoot, 'scripts', 'ask-gate.ts')],
          timeout: 3,
        }],
      },
    ],
    PermissionDenied: [
      {
        matcher: '*',
        hooks: [{
          type: 'command',
          command: 'bun',
          args: ['--no-install', path.resolve(pluginRoot, 'scripts', 'permission-denied-notify.ts')],
          timeout: 12,
        }],
      },
    ],
    PostToolUse: [
      {
        matcher: 'Edit|Write',
        hooks: [{
          type: 'command',
          command: 'bun',
          args: ['--no-install', path.resolve(pluginRoot, 'scripts', 'component-privacy.ts')],
          timeout: 5,
        }],
      },
    ],
  };
}
