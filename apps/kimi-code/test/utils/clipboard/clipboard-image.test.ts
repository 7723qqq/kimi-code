import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { RunCommand } from '#/utils/clipboard/clipboard-common';
import { ClipboardMediaError, readClipboardMedia } from '#/utils/clipboard/clipboard-image';
import type { ClipboardModule } from '#/utils/clipboard/clipboard-native';

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  bytes[16] = (width >>> 24) & 0xff;
  bytes[17] = (width >>> 16) & 0xff;
  bytes[18] = (width >>> 8) & 0xff;
  bytes[19] = width & 0xff;
  bytes[20] = (height >>> 24) & 0xff;
  bytes[21] = (height >>> 16) & 0xff;
  bytes[22] = (height >>> 8) & 0xff;
  bytes[23] = height & 0xff;
  return bytes;
}

function fakeClipboard(overrides: Partial<ClipboardModule>): ClipboardModule {
  return {
    hasImage: () => false,
    getImageBinary: async () => [],
    ...overrides,
  };
}

function noMacOsPaths(): { stdout: Buffer; ok: boolean } {
  return { stdout: Buffer.alloc(0), ok: false };
}

describe('readClipboardMedia', () => {
  it('reads a copied image file from its real path instead of the Finder preview icon', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-code-clip-'));
    try {
      const imagePath = join(dir, 'photo.png');
      const imageBytes = png(12, 34);
      writeFileSync(imagePath, imageBytes);
      let imageBinaryCalls = 0;
      const clip = fakeClipboard({
        availableFormats: () => ['public.file-url', 'public.png'],
        hasImage: () => true,
        getImageBinary: async () => {
          imageBinaryCalls += 1;
          return Array.from(png(1, 1));
        },
      });
      const runCommand: RunCommand = () => ({
        stdout: Buffer.from(`${imagePath}\n`),
        ok: true,
      });

      const media = await readClipboardMedia({ platform: 'darwin', clipboard: clip, runCommand });

      expect(media).toEqual({
        kind: 'image',
        bytes: imageBytes,
        mimeType: 'image/png',
      });
      expect(imageBinaryCalls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers a video file URL over an available image preview', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-code-clip-'));
    try {
      const videoPath = join(dir, 'sample.mov');
      writeFileSync(videoPath, new Uint8Array([0, 1, 2]));
      let imageBinaryCalls = 0;
      const clip = fakeClipboard({
        availableFormats: () => ['public.file-url', 'public.png'],
        hasText: () => true,
        getText: async () => pathToFileURL(videoPath).toString(),
        hasImage: () => true,
        getImageBinary: async () => {
          imageBinaryCalls += 1;
          return [0x89, 0x50, 0x4e, 0x47];
        },
      });

      const media = await readClipboardMedia({
        platform: 'darwin',
        clipboard: clip,
        runCommand: noMacOsPaths,
      });

      expect(media?.kind).toBe('video');
      expect(media).toMatchObject({
        mimeType: 'video/quicktime',
        filename: 'sample.mov',
        sourcePath: videoPath,
      });
      expect(imageBinaryCalls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to native image bytes when no video file is present', async () => {
    const clip = fakeClipboard({
      availableFormats: () => ['public.png'],
      hasText: () => false,
      hasImage: () => true,
      getImageBinary: async () => [0x89, 0x50, 0x4e, 0x47],
    });

    const media = await readClipboardMedia({
      platform: 'darwin',
      clipboard: clip,
      runCommand: noMacOsPaths,
    });

    expect(media).toEqual({
      kind: 'image',
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mimeType: 'image/png',
    });
  });

  it('does not consume file-like clipboard image previews when no real file path is readable', async () => {
    let imageBinaryCalls = 0;
    const clip = fakeClipboard({
      availableFormats: () => ['public.file-url', 'public.png'],
      hasImage: () => true,
      getImageBinary: async () => {
        imageBinaryCalls += 1;
        return Array.from(png(1, 1));
      },
    });

    const media = await readClipboardMedia({
      platform: 'darwin',
      clipboard: clip,
      runCommand: noMacOsPaths,
    });

    expect(media).toBeNull();
    expect(imageBinaryCalls).toBe(0);
  });

  it('rejects pasted videos larger than 100 MB', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-code-clip-'));
    try {
      const videoPath = resolve(dir, 'too-big.mp4');
      writeFileSync(videoPath, new Uint8Array([0]));
      truncateSync(videoPath, 101 * 1024 * 1024);
      const clip = fakeClipboard({
        availableFormats: () => ['public.file-url'],
        hasText: () => true,
        getText: async () => pathToFileURL(videoPath).toString(),
      });

      await expect(
        readClipboardMedia({
          platform: 'darwin',
          clipboard: clip,
          runCommand: noMacOsPaths,
        }),
      ).rejects.toThrow(ClipboardMediaError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a Wayland clipboard image through wl-paste', async () => {
    const imageBytes = png(8, 6);
    const calls: { command: string; args: string[] }[] = [];
    const runCommand: RunCommand = (command, args) => {
      calls.push({ command, args });
      if (args[0] === '--list-types') {
        return { stdout: Buffer.from('text/plain\nimage/png\n'), ok: true };
      }
      if (args[0] === '--type') {
        return { stdout: Buffer.from(imageBytes), ok: true };
      }
      return { stdout: Buffer.alloc(0), ok: false };
    };

    const media = await readClipboardMedia({
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-1' },
      // `null` would fall back to the real native binding, so a no-image fake
      // keeps this test independent of the host clipboard.
      clipboard: fakeClipboard({}),
      runCommand,
    });

    expect(media).toEqual({
      kind: 'image',
      bytes: imageBytes,
      mimeType: 'image/png',
    });
    expect(calls[0]).toEqual({ command: 'wl-paste', args: ['--list-types'] });
    expect(calls).toContainEqual({
      command: 'wl-paste',
      args: ['--type', 'image/png', '--no-newline'],
    });
  });

  it('reaches the Windows clipboard from WSL with the injected env', async () => {
    const imageBytes = png(3, 7);
    let tmpFile = '';
    let powerShellCalls = 0;
    const runCommand: RunCommand = (command, args, options) => {
      if (command === 'wslpath') {
        tmpFile = args[1] ?? '';
        return { stdout: Buffer.from('C:\\Users\\test\\clip.png\n'), ok: true };
      }
      if (command === 'powershell.exe') {
        powerShellCalls += 1;
        const env = options?.env ?? {};
        expect(env['KIMI_WSL_CLIPBOARD_IMAGE_PATH']).toBe('C:\\Users\\test\\clip.png');
        expect(env['KIMI_INJECTED_ENV']).toBe('1');
        // Exactly the injected env plus the temp path: no host variable leaks in.
        expect(Object.keys(env).toSorted()).toEqual([
          'KIMI_INJECTED_ENV',
          'KIMI_WSL_CLIPBOARD_IMAGE_PATH',
          'WSL_DISTRO_NAME',
        ]);
        if (tmpFile === '') throw new Error('wslpath must run before powershell.exe');
        writeFileSync(tmpFile, imageBytes);
        return { stdout: Buffer.from('ok\n'), ok: true };
      }
      return { stdout: Buffer.alloc(0), ok: false };
    };

    const media = await readClipboardMedia({
      platform: 'linux',
      env: { WSL_DISTRO_NAME: 'Ubuntu', KIMI_INJECTED_ENV: '1' },
      // `null` would fall back to the real native binding, so a no-image fake
      // keeps this test independent of the host clipboard.
      clipboard: fakeClipboard({}),
      runCommand,
    });

    expect(media).toEqual({
      kind: 'image',
      bytes: imageBytes,
      mimeType: 'image/png',
    });
    expect(powerShellCalls).toBe(1);
  });
});
