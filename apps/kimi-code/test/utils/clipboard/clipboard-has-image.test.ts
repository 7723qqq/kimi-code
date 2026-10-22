import { describe, expect, it, mock } from 'bun:test';

import { clipboardHasImage } from '#/utils/clipboard/clipboard-has-image';
import type { ClipboardModule } from '#/utils/clipboard/clipboard-native';

function fakeClipboard(overrides: Partial<ClipboardModule>): ClipboardModule {
  return {
    hasImage: mock(() => false),
    getImageBinary: mock(async () => []),
    ...overrides,
  };
}

describe('clipboardHasImage', () => {
  it('returns false on Termux', async () => {
    const result = await clipboardHasImage({ env: { TERMUX_VERSION: '0.118' }, platform: 'linux' });
    expect(result).toBe(false);
  });

  it('returns true when native clipboard reports an image on macOS', async () => {
    const clip = fakeClipboard({ hasImage: mock(() => true) });
    const result = await clipboardHasImage({ platform: 'darwin', clipboard: clip });
    expect(result).toBe(true);
  });

  it('returns false on macOS when native clipboard reports no image', async () => {
    const clip = fakeClipboard({ hasImage: mock(() => false) });
    const result = await clipboardHasImage({ platform: 'darwin', clipboard: clip });
    expect(result).toBe(false);
  });

  it('returns false on macOS when native clipboard throws', async () => {
    const clip = fakeClipboard({
      hasImage: mock(() => {
        throw new Error('native error');
      }),
    });
    const result = await clipboardHasImage({ platform: 'darwin', clipboard: clip });
    expect(result).toBe(false);
  });

  it('returns false on macOS when clipboard contains a file-like native format', async () => {
    const clip = fakeClipboard({
      hasImage: mock(() => true),
      availableFormats: mock(() => ['public.file-url', 'public.png']),
    });
    const result = await clipboardHasImage({ platform: 'darwin', clipboard: clip });
    expect(result).toBe(false);
    expect(clip.hasImage).not.toHaveBeenCalled();
  });

  // The focus-driven hint must not probe the clipboard on Linux: spawning
  // wl-paste / xclip on Wayland perturbs seat focus and re-triggers the
  // terminal focus event, creating a focus feedback loop (issue #1090).
  it('returns false on Linux without reading the clipboard', async () => {
    const clip = fakeClipboard({ hasImage: mock(() => true) });
    const result = await clipboardHasImage({
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-1' },
      clipboard: clip,
    });
    expect(result).toBe(false);
    expect(clip.hasImage).not.toHaveBeenCalled();
  });

  it('returns true on Windows when native clipboard reports an image', async () => {
    const clip = fakeClipboard({ hasImage: mock(() => true) });
    const result = await clipboardHasImage({ platform: 'win32', clipboard: clip });
    expect(result).toBe(true);
  });

  it('returns false on Windows when native clipboard reports no image', async () => {
    const clip = fakeClipboard({ hasImage: mock(() => false) });
    const result = await clipboardHasImage({ platform: 'win32', clipboard: clip });
    expect(result).toBe(false);
  });
});
