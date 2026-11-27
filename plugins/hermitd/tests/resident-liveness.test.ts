import { describe, expect, test } from 'bun:test';
import { bootOwner, residentLiveness } from '../scripts/lib/resident-liveness';

const verdict = (runtime: Parameters<typeof residentLiveness>[0], alive = false, age: number | null = null) =>
  residentLiveness(runtime, 'resident', { tmuxAlive: () => alive, livenessAgeSecs: () => age });

describe('resident liveness', () => {
  test('absent runtime or mode has no resident', () => {
    expect(verdict(null).state).toBe('none');
    expect(verdict({}).state).toBe('none');
  });
  test('live tmux', () => expect(verdict({ runtime_mode: 'tmux' }, true).state).toBe('alive'));
  test('clean stop', () => expect(verdict({ runtime_mode: 'tmux', shutdown_completed_at: 'stamp' }).state).toBe('cleanly-stopped'));
  test('interactive', () => expect(verdict({ runtime_mode: 'interactive' }).state).toBe('interactive'));
  test('orphan', () => expect(verdict({ runtime_mode: 'tmux' }, false, 12).state).toBe('orphan'));
  test('dead', () => expect(verdict({ runtime_mode: 'tmux' }, false, 600).state).toBe('dead'));
  test('fresh activity without a mode is an orphan', () => expect(verdict({}, false, 5).state).toBe('orphan'));
  test('live tmux precedes a clean stamp', () => expect(verdict({ runtime_mode: 'tmux', shutdown_completed_at: 'stamp' }, true).state).toBe('alive'));
  test('clean stamp precedes fresh activity', () => expect(verdict({ runtime_mode: 'tmux', shutdown_completed_at: 'stamp' }, false, 1).state).toBe('cleanly-stopped'));
});

describe('boot owner', () => {
  test('fresh activity of another runtime owns the state', () => {
    expect(bootOwner(verdict({ runtime_mode: 'docker' }, false, 1.25), 'tmux')).toEqual({ mode: 'docker', age_secs: 1, via: 'liveness' });
    expect(bootOwner(verdict({ runtime_mode: 'tmux' }, false, 42), 'docker')).toEqual({ mode: 'tmux', age_secs: 42, via: 'liveness' });
    expect(bootOwner(verdict({ runtime_mode: 'tmux' }, false, 1), 'interactive')?.mode).toBe('tmux');
  });
  test('the same runtime, no mode, stale activity or a clean stop own nothing', () => {
    expect(bootOwner(verdict({ runtime_mode: 'tmux' }, false, 1), 'tmux')).toBeNull();
    expect(bootOwner(verdict({}, false, 1), 'docker')).toBeNull();
    expect(bootOwner(verdict({ runtime_mode: 'docker' }, false, 600), 'tmux')).toBeNull();
    expect(bootOwner(verdict({ runtime_mode: 'docker' }, false, null), 'tmux')).toBeNull();
    expect(bootOwner(verdict({ runtime_mode: 'tmux', shutdown_completed_at: 'stamp' }, false, 1), 'docker')).toBeNull();
  });
  test('a live host tmux session owns the state for a Docker boot, even stale or stamped', () => {
    expect(bootOwner(verdict({ runtime_mode: 'tmux' }, true, null), 'docker')).toEqual({ mode: 'tmux', age_secs: null, via: 'tmux' });
    expect(bootOwner(verdict({ runtime_mode: 'tmux', shutdown_completed_at: 'stamp' }, true, 900), 'docker')?.via).toBe('tmux');
  });
  test('a host boot leaves its own tmux session to the lifecycle lock', () => {
    expect(bootOwner(verdict({ runtime_mode: 'interactive' }, true, null), 'tmux')).toBeNull();
  });
});

test('live tmux without runtime mode is alive', () => {
  const result = verdict({}, true);
  expect(result.state).toBe('alive');
  expect(result.evidence.tmuxAlive).toBe(true);
});
