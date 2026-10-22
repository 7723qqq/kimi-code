import { describe, expect, it } from 'bun:test';

import type { ClipboardModule } from '#/utils/clipboard/clipboard-native';
import { buildClipboardOSC52, writeClipboardOSC52 } from '#/utils/clipboard/clipboard-osc52';
import {
  copyTextToClipboard,
  type ClipboardWriteOptions,
  type CopyTextDeps,
} from '#/utils/clipboard/clipboard-text';

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

function failingRun(): { status: number; stderr: string } {
  return { status: 1, stderr: 'missing' };
}

describe('copyTextToClipboard', () => {
  it('copies text with the native clipboard when available', async () => {
    const copied: string[] = [];
    const deps: Partial<CopyTextDeps> = {
      clipboard: fakeClipboard({
        setText: async (text) => {
          copied.push(text);
        },
      }),
      osc52: () => false,
      run: failingRun,
    };

    await expect(copyTextToClipboard('cd "/tmp/proj-b"', deps)).resolves.toBe('native');
    expect(copied).toEqual(['cd "/tmp/proj-b"']);
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
      copyTextToClipboard('cd "/tmp/proj-b"', { clipboard: clip, osc52: () => false }),
    ).resolves.toBe('native');
    expect(clip.seen).toBe('cd "/tmp/proj-b"');
  });

  it('throws an Error when all platform clipboard commands fail', async () => {
    const deps: Partial<CopyTextDeps> = {
      clipboard: null,
      platform: 'linux',
      osc52: () => false,
      run: failingRun,
    };

    await expect(copyTextToClipboard('cd "/tmp/proj-b"', deps)).rejects.toBeInstanceOf(Error);
    await expect(copyTextToClipboard('cd "/tmp/proj-b"', deps)).rejects.toThrow(
      /(?:clip\.exe|pbcopy|wl-copy|xclip) exited with code 1: missing/,
    );
  });

  it('bounds the platform write helper with a finite timeout', async () => {
    const calls: { command: string; options: ClipboardWriteOptions }[] = [];
    const deps: Partial<CopyTextDeps> = {
      clipboard: null,
      platform: 'linux',
      osc52: () => false,
      run: (command, _args, options) => {
        calls.push({ command, options });
        return command === 'xclip' ? { status: 0, stderr: '' } : failingRun();
      },
    };

    await copyTextToClipboard('cd "/tmp/proj-b"', deps);

    // Both candidates must carry the bound: with no `timeout` the parent waits
    // for the child's stdout to close, and a daemonizing `wl-copy`/`xclip`
    // keeps that pipe open forever (the CLI hangs silently).
    expect(calls.map((call) => call.command)).toEqual(['wl-copy', 'xclip']);
    for (const call of calls) {
      expect(typeof call.options.timeoutMs).toBe('number');
      expect(call.options.timeoutMs).toBeGreaterThan(0);
      expect(call.options.input).toBe('cd "/tmp/proj-b"');
    }
  });
});

describe('copyTextToClipboard platform commands', () => {
  const cases = [
    { platform: 'darwin', command: 'pbcopy' },
    { platform: 'win32', command: 'clip.exe' },
    { platform: 'linux', command: 'wl-copy' },
  ] as const;

  for (const { platform, command } of cases) {
    it(`uses ${command} on ${platform}`, async () => {
      const seen: string[] = [];
      await copyTextToClipboard('payload', {
        clipboard: null,
        platform,
        osc52: () => false,
        run: (name) => {
          seen.push(name);
          return { status: 0, stderr: '' };
        },
      });

      expect(seen).toEqual([command]);
    });
  }
});

describe('buildClipboardOSC52', () => {
  it('emits a bare OSC 52 sequence outside tmux', () => {
    expect(buildClipboardOSC52('hi', false)).toBe(`\u001B]52;c;${base64('hi')}\u0007`);
  });

  it('wraps the sequence in a tmux passthrough with doubled ESC bytes', () => {
    expect(buildClipboardOSC52('hi', true)).toBe(
      `\u001BPtmux;\u001B\u001B]52;c;${base64('hi')}\u0007\u001B\\`,
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

describe('OSC 52 fallback in copyTextToClipboard', () => {
  it('resolves via OSC 52 when native clipboards fail on a terminal', async () => {
    const emitted: string[] = [];

    const method = await copyTextToClipboard('hello world', {
      clipboard: null,
      platform: 'linux',
      run: failingRun,
      osc52: (text) => {
        emitted.push(text);
        return true;
      },
    });

    expect(method).toBe('osc52');
    expect(emitted).toEqual(['hello world']);
  });

  it('emits OSC 52 before trying the native clipboard', async () => {
    const events: string[] = [];

    await copyTextToClipboard('hello', {
      clipboard: fakeClipboard({
        setText: async () => {
          events.push('native');
        },
      }),
      osc52: () => {
        events.push('osc52');
        return true;
      },
    });

    expect(events).toEqual(['osc52', 'native']);
  });
});
