import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'bun:test';

import { t } from '#/i18n';
import type { ClipboardModule } from '#/utils/clipboard/clipboard-native';
import { buildClipboardOSC52, writeClipboardOSC52 } from '#/utils/clipboard/clipboard-osc52';
import {
  CLIPBOARD_COMMAND_TIMEOUT_MS,
  copyTextToClipboard,
  planClipboardWrite,
  type ClipboardSpawn,
  type CopyTextDeps,
} from '#/utils/clipboard/clipboard-text';
import { resolveCommandPath } from '#/utils/process/resolve-command';
import { createFakeClock } from '#test/helpers/fake-clock';

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function fakeClipboard(overrides: Partial<ClipboardModule> = {}): ClipboardModule {
  return {
    hasImage: () => false,
    getImageBinary: async () => [],
    ...overrides,
  };
}

interface SpawnCall {
  readonly command: string;
  input: string;
}

function fakeSpawn(exitCodeByCommand: Record<string, number>): {
  spawn: ClipboardSpawn;
  calls: SpawnCall[];
  kills: string[];
} {
  const calls: SpawnCall[] = [];
  const kills: string[] = [];
  const spawn: ClipboardSpawn = (command) => {
    const name = basename(command);
    const call: SpawnCall = { command: name, input: '' };
    calls.push(call);
    let settle!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      settle = resolve;
    });
    return {
      exited,
      stdin: {
        write(data: string) {
          call.input += data;
        },
        end() {
          const code = exitCodeByCommand[name];
          queueMicrotask(() => settle(code ?? 127));
        },
        destroy() {},
      },
      kill(signal?: string) {
        kills.push(signal ?? '');
        settle(-1);
      },
    };
  };
  return { spawn, calls, kills };
}

function captureOSC52(): { osc52: (text: string) => boolean; written: string[] } {
  const written: string[] = [];
  return {
    osc52: (text) => {
      written.push(text);
      return true;
    },
    written,
  };
}

function deps(overrides: Partial<CopyTextDeps> = {}): Partial<CopyTextDeps> {
  return {
    clipboard: fakeClipboard({ setText: async () => {} }),
    osc52: () => false,
    resolveCommand: (command) => `/fake/bin/${command}`,
    spawn: fakeSpawn({}).spawn,
    ...overrides,
  };
}

describe('planClipboardWrite', () => {
  const pbcopy = { command: 'pbcopy', args: [] };
  const wlCopy = { command: 'wl-copy', args: [] };
  const xclip = { command: 'xclip', args: ['-selection', 'clipboard'] };
  const xsel = { command: 'xsel', args: ['--clipboard', '--input'] };
  const unavailable = t('tui.statusMessages.clipboardUnavailable');
  const missingX11 = t('tui.statusMessages.clipboardUnavailableX11');
  const missingWayland = t('tui.statusMessages.clipboardUnavailableWayland');
  const missingTermux = t('tui.statusMessages.clipboardUnavailableTermux');

  it.each<[string, NodeJS.Platform, NodeJS.ProcessEnv, ReturnType<typeof planClipboardWrite>]>([
    [
      'macOS',
      'darwin',
      {},
      { nativeModule: true, commands: [pbcopy], osc52: 'never', unavailableMessage: unavailable },
    ],
    [
      'Windows',
      'win32',
      {},
      {
        nativeModule: true,
        commands: [{ command: 'clip.exe', args: [] }],
        osc52: 'never',
        unavailableMessage: unavailable,
      },
    ],
    [
      'Linux X11',
      'linux',
      { DISPLAY: ':0' },
      { nativeModule: false, commands: [xclip, xsel], osc52: 'never', unavailableMessage: missingX11 },
    ],
    [
      'Linux Wayland with XWayland',
      'linux',
      { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' },
      {
        nativeModule: false,
        commands: [wlCopy, xclip, xsel],
        osc52: 'never',
        unavailableMessage: missingWayland,
      },
    ],
    [
      'Wayland session without WAYLAND_DISPLAY',
      'linux',
      { XDG_SESSION_TYPE: 'wayland' },
      { nativeModule: false, commands: [wlCopy], osc52: 'never', unavailableMessage: missingWayland },
    ],
    [
      'Linux without a display',
      'linux',
      {},
      { nativeModule: false, commands: [], osc52: 'fallback', unavailableMessage: unavailable },
    ],
    [
      'WSLg',
      'linux',
      { WSL_DISTRO_NAME: 'Ubuntu', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' },
      {
        nativeModule: false,
        commands: [wlCopy, xclip, xsel],
        osc52: 'fallback',
        unavailableMessage: missingWayland,
      },
    ],
    [
      'Termux',
      'android',
      { TERMUX_VERSION: '0.118' },
      {
        nativeModule: true,
        commands: [{ command: 'termux-clipboard-set', args: [] }],
        osc52: 'fallback',
        unavailableMessage: missingTermux,
      },
    ],
    [
      'SSH into Linux',
      'linux',
      { SSH_CONNECTION: '10.0.0.1 5000 10.0.0.2 22' },
      { nativeModule: false, commands: [], osc52: 'always', unavailableMessage: unavailable },
    ],
    [
      'SSH into a Linux desktop',
      'linux',
      { SSH_CLIENT: '10.0.0.1 5000 22', DISPLAY: ':0' },
      { nativeModule: false, commands: [xclip, xsel], osc52: 'always', unavailableMessage: missingX11 },
    ],
    [
      'mosh into macOS',
      'darwin',
      { MOSH_CONNECTION: '10.0.0.1' },
      { nativeModule: true, commands: [pbcopy], osc52: 'always', unavailableMessage: unavailable },
    ],
    [
      'KIMI_CODE_CLIPBOARD_OSC52=1 on a Linux desktop',
      'linux',
      { KIMI_CODE_CLIPBOARD_OSC52: '1', DISPLAY: ':0' },
      { nativeModule: false, commands: [xclip, xsel], osc52: 'always', unavailableMessage: missingX11 },
    ],
    [
      'KIMI_CODE_CLIPBOARD_OSC52=0',
      'linux',
      { KIMI_CODE_CLIPBOARD_OSC52: '0', DISPLAY: ':0' },
      { nativeModule: false, commands: [xclip, xsel], osc52: 'never', unavailableMessage: missingX11 },
    ],
  ])('%s', (_name, platform, env, expected) => {
    expect(planClipboardWrite(platform, env)).toEqual(expected);
  });
});

describe('copyTextToClipboard', () => {
  it('copies text with the native clipboard when available', async () => {
    const copied: string[] = [];
    const spawn = fakeSpawn({});

    await expect(
      copyTextToClipboard('cd "/tmp/proj-b"', {
        ...deps({
          clipboard: fakeClipboard({
            setText: async (text) => {
              copied.push(text);
            },
          }),
          platform: 'darwin',
          spawn: spawn.spawn,
        }),
      }),
    ).resolves.toBe('native');
    expect(copied).toEqual(['cd "/tmp/proj-b"']);
    expect(spawn.calls).toEqual([]);
  });

  it('keeps native clipboard method context when copying text', async () => {
    const clip: ClipboardModule & { seen?: string } = {
      hasImage: () => false,
      getImageBinary: () => Promise.resolve([]),
      setText(text: string): Promise<void> {
        this.seen = text;
        return Promise.resolve();
      },
    };

    await expect(
      copyTextToClipboard('cd "/tmp/proj-b"', deps({ clipboard: clip, platform: 'darwin' })),
    ).resolves.toBe('native');
    expect(clip.seen).toBe('cd "/tmp/proj-b"');
  });

  it('falls back to pbcopy when the native clipboard fails on macOS', async () => {
    const spawn = fakeSpawn({ pbcopy: 0 });

    await expect(
      copyTextToClipboard('hello', {
        ...deps({
          clipboard: fakeClipboard({ setText: async () => Promise.reject(new Error('native failed')) }),
          platform: 'darwin',
          spawn: spawn.spawn,
        }),
      }),
    ).resolves.toBe('native');
    expect(spawn.calls).toEqual([{ command: 'pbcopy', input: 'hello' }]);
  });

  it('never trusts the native module on Linux and writes through the CLI tools', async () => {
    let nativeCalled = false;
    const native = fakeClipboard({
      setText: async () => {
        nativeCalled = true;
      },
    });
    const spawn = fakeSpawn({ xclip: 1, xsel: 0 });
    const osc52 = captureOSC52();

    await expect(
      copyTextToClipboard('hello', {
        ...deps({
          clipboard: native,
          platform: 'linux',
          env: { DISPLAY: ':0' },
          spawn: spawn.spawn,
          osc52: osc52.osc52,
        }),
      }),
    ).resolves.toBe('native');
    expect(nativeCalled).toBe(false);
    expect(spawn.calls).toEqual([
      { command: 'xclip', input: 'hello' },
      { command: 'xsel', input: 'hello' },
    ]);
    expect(osc52.written).toEqual([]);
  });

  it('still emits OSC 52 to the client terminal of a remote session after a native copy', async () => {
    const osc52 = captureOSC52();

    await expect(
      copyTextToClipboard('hello world', {
        ...deps({
          platform: 'darwin',
          env: { SSH_CONNECTION: '10.0.0.1 5000 10.0.0.2 22' },
          osc52: osc52.osc52,
        }),
      }),
    ).resolves.toBe('native');
    expect(osc52.written).toEqual(['hello world']);
  });

  it('reaches the client terminal of a remote session while the system clipboard is still busy', async () => {
    let finishNativeCopy = (): void => {};
    const osc52 = captureOSC52();

    const copy = copyTextToClipboard('hello world', {
      ...deps({
        clipboard: fakeClipboard({
          setText: () =>
            new Promise<void>((resolve) => {
              finishNativeCopy = resolve;
            }),
        }),
        platform: 'darwin',
        env: { SSH_CONNECTION: '10.0.0.1 5000 10.0.0.2 22' },
        osc52: osc52.osc52,
      }),
    });

    expect(osc52.written).toEqual(['hello world']);
    finishNativeCopy();
    await expect(copy).resolves.toBe('native');
  });

  it('falls back to OSC 52 on Linux without a display', async () => {
    const spawn = fakeSpawn({});
    const osc52 = captureOSC52();

    await expect(
      copyTextToClipboard('hello world', {
        ...deps({ platform: 'linux', env: {}, spawn: spawn.spawn, osc52: osc52.osc52 }),
      }),
    ).resolves.toBe('osc52');
    expect(spawn.calls).toEqual([]);
    expect(osc52.written).toEqual(['hello world']);
  });

  it('falls back to OSC 52 under WSLg when no clipboard tool is installed', async () => {
    const spawn = fakeSpawn({});
    const osc52 = captureOSC52();

    await expect(
      copyTextToClipboard('hello', {
        ...deps({
          platform: 'linux',
          env: { WSL_DISTRO_NAME: 'Ubuntu', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' },
          resolveCommand: () => undefined,
          spawn: spawn.spawn,
          osc52: osc52.osc52,
        }),
      }),
    ).resolves.toBe('osc52');
    expect(spawn.calls).toEqual([]);
    expect(osc52.written).toEqual(['hello']);
  });

  it('reports a missing X11 tool instead of trusting OSC 52 on a Linux desktop', async () => {
    const osc52 = captureOSC52();

    await expect(
      copyTextToClipboard('hello', {
        ...deps({
          platform: 'linux',
          env: { DISPLAY: ':0' },
          resolveCommand: () => undefined,
          osc52: osc52.osc52,
        }),
      }),
    ).rejects.toThrow(t('tui.statusMessages.clipboardUnavailableX11'));
    expect(osc52.written).toEqual([]);
  });

  it('reports a missing Wayland tool', async () => {
    const spawn = fakeSpawn({ 'wl-copy': 1 });

    await expect(
      copyTextToClipboard('hello', {
        ...deps({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, spawn: spawn.spawn }),
      }),
    ).rejects.toThrow(t('tui.statusMessages.clipboardUnavailableWayland'));
  });

  it('sends long text through OSC 52 without a size cap', async () => {
    const osc52 = captureOSC52();
    const text = 'x'.repeat(1_000_000);

    await expect(
      copyTextToClipboard(text, deps({ platform: 'linux', env: {}, osc52: osc52.osc52 })),
    ).resolves.toBe('osc52');
    expect(osc52.written).toEqual([text]);
  });

  it('spawns clipboard tools by their resolved absolute path', async () => {
    const spawn = fakeSpawn({ pbcopy: 0 });
    const resolved: string[] = [];

    await expect(
      copyTextToClipboard('hello', {
        ...deps({
          clipboard: fakeClipboard({ setText: async () => Promise.reject(new Error('native failed')) }),
          platform: 'darwin',
          spawn: spawn.spawn,
          resolveCommand: (command) => {
            resolved.push(command);
            return join('/tools', command);
          },
        }),
      }),
    ).resolves.toBe('native');
    expect(resolved).toEqual(['pbcopy']);
    expect(spawn.calls).toEqual([{ command: 'pbcopy', input: 'hello' }]);
  });

  it('never spawns a clipboard tool planted in the workspace', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'kimi-clipboard-cwd-')));
    mkdirSync(join(workspace, 'bin'));
    for (const tool of ['xclip', 'xsel']) {
      writeFileSync(join(workspace, 'bin', tool), '', { mode: 0o755 });
    }
    const env = { DISPLAY: ':0', PATH: join(workspace, 'bin') };
    const spawn = fakeSpawn({ xclip: 0, xsel: 0 });

    await expect(
      copyTextToClipboard('hello', {
        ...deps({
          platform: 'linux',
          env,
          spawn: spawn.spawn,
          resolveCommand: (command) =>
            resolveCommandPath(command, workspace, { platform: 'linux', env }),
        }),
      }),
    ).rejects.toThrow(t('tui.statusMessages.clipboardUnavailableX11'));
    expect(spawn.calls).toEqual([]);
  });

  it('kills a clipboard tool that never exits and reports it as failed', async () => {
    const clock = createFakeClock(0);
    const kills: string[] = [];
    const spawn: ClipboardSpawn = () => ({
      exited: new Promise<number>(() => {}),
      stdin: { write() {}, end() {}, destroy() {} },
      kill(signal?: string) {
        kills.push(signal ?? '');
      },
    });

    const copy = copyTextToClipboard('hello', {
      ...deps({
        platform: 'linux',
        env: { WAYLAND_DISPLAY: 'wayland-0' },
        spawn,
        clock,
      }),
    });
    clock.advance(CLIPBOARD_COMMAND_TIMEOUT_MS);

    await expect(copy).rejects.toThrow(t('tui.statusMessages.clipboardUnavailableWayland'));
    expect(kills).toEqual(['SIGKILL']);
  });

  it('does not write escape sequences when the terminal sink is not a TTY', async () => {
    let writes = 0;
    await expect(
      copyTextToClipboard('hello', {
        ...deps({
          platform: 'linux',
          env: {},
          resolveCommand: () => undefined,
          osc52: (text) =>
            writeClipboardOSC52(text, {
              isTTY: false,
              write: () => {
                writes += 1;
                return true;
              },
            }),
        }),
      }),
    ).rejects.toThrow(new RegExp(`^${t('tui.statusMessages.clipboardUnavailable')}$`, 'u'));
    expect(writes).toBe(0);
  });
});

describe('buildClipboardOSC52', () => {
  it('emits a bare OSC 52 sequence outside tmux', () => {
    expect(buildClipboardOSC52('hi', false)).toBe(`\u001B]52;c;${base64('hi')}\u0007`);
  });

  it('sends both the bare sequence and the tmux passthrough form inside tmux', () => {
    expect(buildClipboardOSC52('hi', true)).toBe(
      `\u001B]52;c;${base64('hi')}\u0007\u001BPtmux;\u001B\u001B]52;c;${base64('hi')}\u0007\u001B\\`,
    );
  });
});

describe('writeClipboardOSC52', () => {
  it('writes the sequence to a terminal sink', () => {
    const chunks: string[] = [];

    const written = writeClipboardOSC52('hi', {
      isTTY: true,
      write: (chunk) => {
        chunks.push(chunk);
        return true;
      },
    });

    expect(written).toBe(true);
    expect(chunks.join('')).toContain(`]52;c;${base64('hi')}`);
  });

  it('does not write escape sequences to a non-terminal sink', () => {
    let writes = 0;

    const written = writeClipboardOSC52('hi', {
      isTTY: false,
      write: () => {
        writes += 1;
        return true;
      },
    });

    expect(written).toBe(false);
    expect(writes).toBe(0);
  });

  it('reports a failed write as not emitted', () => {
    const written = writeClipboardOSC52('hi', {
      isTTY: true,
      write: () => {
        throw new Error('EPIPE');
      },
    });

    expect(written).toBe(false);
  });
});
