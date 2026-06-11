import { describe, expect, it } from 'vitest';
import {
  openFileCommandFor,
  revealFileCommandFor,
} from '../src/lib/fileLaunch';

describe('file launch commands', () => {
  it('uses configured editors and preserves line targets for VS Code style editors', () => {
    expect(openFileCommandFor('/repo/src/App.vue', 12, { KIMI_CODE_EDITOR: 'code -g' }, 'darwin')).toEqual({
      command: "code -g '/repo/src/App.vue:12'",
      args: [],
      shell: true,
    });
  });

  it('falls back to platform openers without an editor', () => {
    expect(openFileCommandFor('/repo/src/App.vue', undefined, {}, 'darwin')).toEqual({
      command: 'open',
      args: ['/repo/src/App.vue'],
    });
    expect(openFileCommandFor('/repo/src/App.vue', undefined, {}, 'linux')).toEqual({
      command: 'xdg-open',
      args: ['/repo/src/App.vue'],
    });
  });

  it('reveals files with platform-specific commands', () => {
    expect(revealFileCommandFor('/repo/src/App.vue', 'darwin')).toEqual({
      command: 'open',
      args: ['-R', '/repo/src/App.vue'],
    });
    expect(revealFileCommandFor('/repo/src/App.vue', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['/repo/src'],
    });
  });
});
