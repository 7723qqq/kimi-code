/**
 * Clipboard image paste → attachment store, with ingestion-time compression.
 *
 * Tests pin:
 *   - an oversized pasted image is downsampled while building the attachment,
 *     so the stored bytes, the `[image #N (W×H)]` placeholder, and the eventual
 *     submitted image all agree on the compressed size
 *   - the pre-compression original is persisted and recorded on the
 *     attachment, so the submitted prompt can announce the compression and
 *     point the model at the full-fidelity bytes
 *   - a within-budget paste is stored byte-for-byte (fast path), with no
 *     original recorded
 */

import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ImageLimits, IMAGE_BYTE_BUDGET, type KimiHarness } from '@moonshot-ai/kimi-code-sdk';
import { Jimp } from 'jimp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EditorKeyboardController,
  type EditorKeyboardHost,
} from '#/tui/controllers/editor-keyboard';
import { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';
import { extractMediaAttachments, resolveOriginalCaptions } from '#/tui/utils/image-placeholder';
import { parseImageMeta } from '#/utils/image/image-mime';

// vitest hoists vi.mock/vi.hoisted above the imports above, so the mock still
// applies to the editor-keyboard module that pulls in readClipboardMedia.
const { readClipboardMedia } = vi.hoisted(() => ({ readClipboardMedia: vi.fn() }));

vi.mock('#/utils/clipboard/clipboard-image', async (importActual) => {
  const actual = await importActual<typeof import('#/utils/clipboard/clipboard-image')>();
  return { ...actual, readClipboardMedia };
});

interface PasteHarness {
  readonly store: ImageAttachmentStore;
  readonly track: ReturnType<typeof vi.fn>;
  readonly controller: EditorKeyboardController;
  readonly editor: Record<string, ((...args: never[]) => unknown) | undefined>;
  /** Invoke the paste handler, then wait for the background ingestion to settle. */
  pasteImage(): Promise<void>;
  /** Invoke the paste handler only — background ingestion may still be pending. */
  pasteImageRaw(): Promise<boolean>;
}

function createPasteHarness(
  options: {
    sessionDir?: string;
    imageLimits?: ImageLimits;
    uploadFile?: (
      data: Uint8Array,
      opts: { name: string; mimeType?: string; expiresInSec?: number },
    ) => Promise<{ id: string }>;
  } = {},
): PasteHarness {
  const editor: Record<string, ((...args: never[]) => unknown) | undefined> = {
    setHistoryFilter: vi.fn() as unknown as (...args: never[]) => unknown,
    insertTextAtCursor: vi.fn() as unknown as (...args: never[]) => unknown,
  };
  const store = new ImageAttachmentStore();
  const track = vi.fn();
  const host = {
    state: {
      editor,
      activeDialog: null,
      appState: { streamingPhase: 'idle', isCompacting: false },
      footer: { setTransientHint: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session:
      options.sessionDir === undefined
        ? undefined
        : { summary: { sessionDir: options.sessionDir } },
    btwPanelController: { closeOrCancel: vi.fn(() => false) },
    track,
    showError: vi.fn(),
    openUndoSelector: vi.fn(),
    cancelRunningShellCommand: vi.fn(),
  } as unknown as EditorKeyboardHost;
  if (options.imageLimits !== undefined || options.uploadFile !== undefined) {
    (host as unknown as { harness: KimiHarness }).harness = {
      imageLimits: options.imageLimits,
      uploadFile: options.uploadFile,
    } as unknown as KimiHarness;
  }

  const controller = new EditorKeyboardController(host, store);
  controller.install();

  const pasteImageRaw = (): Promise<boolean> => {
    const handler = editor['onPasteImage'];
    if (handler === undefined) throw new Error('onPasteImage handler not installed');
    return (handler as () => Promise<boolean>)();
  };

  return {
    store,
    track,
    controller,
    editor,
    async pasteImage() {
      await pasteImageRaw();
      // Ingestion (compression, daemon upload) runs in the background after
      // the handler settles — wait for it so assertions see the final
      // attachment, not the placeholder-time snapshot.
      for (let id = 1; id <= store.size(); id++) {
        await store.get(id)?.pending;
      }
    },
    pasteImageRaw,
  };
}

async function solidPng(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(
    await new Jimp({ width, height, color: 0x3366ccff }).getBuffer('image/png'),
  );
}

async function solidJpeg(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(
    await new Jimp({ width, height, color: 0x3366ccff }).getBuffer('image/jpeg', { quality: 90 }),
  );
}

/** Typed `uploadFile` stub so `mock.calls` keeps the (data, options) tuple. */
function uploadFileMock(id: string) {
  return vi.fn(
    async (_data: Uint8Array, _opts: { name: string; mimeType?: string; expiresInSec?: number }) => ({
      id,
      expires_at: '2030-01-02T03:04:05.000Z',
    }),
  );
}

/**
 * Insert a minimal EXIF APP1 segment carrying only an Orientation tag right
 * after the JPEG SOI marker (jimp itself never writes EXIF).
 */
function withExifOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  // TIFF body, little-endian: 8-byte header + IFD0 with a single entry.
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // offset of IFD0
  tiff.writeUInt16LE(1, 8); // one directory entry
  tiff.writeUInt16LE(0x0112, 10); // tag: Orientation
  tiff.writeUInt16LE(3, 12); // type: SHORT
  tiff.writeUInt32LE(1, 14); // count
  tiff.writeUInt16LE(orientation, 18); // value, left-aligned in the 4-byte field
  tiff.writeUInt32LE(0, 22); // no next IFD
  const exifBody = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1Header = Buffer.alloc(4);
  app1Header.writeUInt16BE(0xff_e1, 0);
  app1Header.writeUInt16BE(exifBody.length + 2, 2);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(jpeg.subarray(0, 2)), // SOI
      app1Header,
      exifBody,
      Buffer.from(jpeg.subarray(2)),
    ]),
  );
}

describe('clipboard image paste compression', () => {
  beforeEach(() => {
    readClipboardMedia.mockReset();
  });

  it('downsamples an oversized pasted image before storing it', async () => {
    const big = await solidPng(3600, 1800);
    readClipboardMedia.mockResolvedValue({ kind: 'image', bytes: big, mimeType: 'image/png' });

    const { store, pasteImage } = createPasteHarness();
    await pasteImage();

    expect(store.size()).toBe(1);
    const att = store.get(1);
    expect(att?.kind).toBe('image');
    if (att?.kind !== 'image') throw new Error('expected image attachment');

    // Stored metadata reflects the compressed size.
    expect(Math.max(att.width, att.height)).toBeLessThanOrEqual(2000);
    expect(att.placeholder).toContain('2000×1000');

    // The stored bytes decode to the compressed dimensions — the thumbnail and
    // the submitted image both read from these bytes, so they cannot diverge.
    const dims = parseImageMeta(att.bytes);
    expect(dims).not.toBeNull();
    expect(Math.max(dims!.width, dims!.height)).toBeLessThanOrEqual(3000);
  });

  it('honors the harness [image] max_edge_px when pasting', async () => {
    const big = await solidPng(3600, 1800);
    readClipboardMedia.mockResolvedValue({ kind: 'image', bytes: big, mimeType: 'image/png' });

    const { store, pasteImage } = createPasteHarness({
      imageLimits: new ImageLimits(process.env, { maxEdgePx: 800 }),
    });
    await pasteImage();

    const att = store.get(1);
    if (att?.kind !== 'image') throw new Error('expected image attachment');
    // The harness [image] config — not the built-in 2000px — drives ingestion.
    expect(Math.max(att.width, att.height)).toBe(800);
    expect(att.placeholder).toContain('800×400');
    const dims = parseImageMeta(att.bytes);
    expect(dims).not.toBeNull();
    expect(Math.max(dims!.width, dims!.height)).toBe(800);
  });

  it('records and persists the pre-compression original for an oversized paste', async () => {
    const big = await solidPng(3600, 1800);
    readClipboardMedia.mockResolvedValue({ kind: 'image', bytes: big, mimeType: 'image/png' });

    const { store, pasteImage } = createPasteHarness();
    await pasteImage();

    const att = store.get(1);
    if (att?.kind !== 'image') throw new Error('expected image attachment');
    // Paste time keeps the original in memory — the session (and its
    // media-originals dir) may not exist yet, so nothing is written yet.
    expect(att.original).toBeDefined();
    expect(att.original?.width).toBe(3600);
    expect(att.original?.height).toBe(1800);
    expect(att.original?.byteLength).toBe(big.length);
    expect(att.original?.mime).toBe('image/png');
    expect(att.original?.path).toBeUndefined();

    // Dispatch-time caption resolution persists it and authors the caption.
    const extracted = await extractMediaAttachments(att.placeholder, store);
    const resolved = resolveOriginalCaptions(
      extracted.parts,
      extracted.imageAttachmentIds,
      store,
      undefined,
    );
    const caption = resolved[0];
    if (caption?.type !== 'text') throw new Error('expected leading caption text');
    expect(caption.text).toContain('Image compressed');
    expect(att.original?.path).not.toBeNull();

    // The original bytes are readable back from the persisted path.
    const persisted = await readFile(att.original!.path!);
    expect(new Uint8Array(persisted)).toEqual(big);
    await unlink(att.original!.path!).catch(() => undefined);
  });

  it('persists the original into the session media-originals dir when the session is known', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-paste-session-'));
    const big = await solidPng(3600, 1800);
    readClipboardMedia.mockResolvedValue({ kind: 'image', bytes: big, mimeType: 'image/png' });

    const { store, pasteImage } = createPasteHarness({ sessionDir });
    await pasteImage();

    const att = store.get(1);
    if (att?.kind !== 'image') throw new Error('expected image attachment');
    // The original is written by dispatch-time caption resolution, into the
    // session's media-originals dir (not the shared temp dir).
    const extracted = await extractMediaAttachments(att.placeholder, store);
    resolveOriginalCaptions(
      extracted.parts,
      extracted.imageAttachmentIds,
      store,
      join(sessionDir, 'media-originals'),
    );
    expect(att.original?.path).not.toBeNull();
    expect(att.original!.path!.startsWith(join(sessionDir, 'media-originals'))).toBe(true);
    const persisted = await readFile(att.original!.path!);
    expect(new Uint8Array(persisted)).toEqual(big);
    await rm(sessionDir, { recursive: true, force: true });
  });

  it('stores a within-budget paste byte-for-byte', async () => {
    const small = await solidPng(80, 80);
    readClipboardMedia.mockResolvedValue({ kind: 'image', bytes: small, mimeType: 'image/png' });

    const { store, pasteImage } = createPasteHarness();
    await pasteImage();

    const att = store.get(1);
    if (att?.kind !== 'image') throw new Error('expected image attachment');
    expect(att.width).toBe(80);
    expect(att.height).toBe(80);
    expect(att.bytes).toBe(small); // identity: no re-encode on the fast path
    expect(att.original).toBeUndefined();
  });

  it('records an EXIF-rotated compressed original in display space', async () => {
    // Orientation 6 (rotate 90° CW): the header says 3600x400, but the image
    // decodes to 400x3600 — the space the compressed bytes and any later
    // Read region readback live in. The recorded original (which
    // drives the submit-time compression caption) must match that space, or
    // the caption contradicts the sent image's aspect and region coordinates
    // land axis-swapped. (Kept narrow: pure-JS decode+rotate+encode of a
    // larger frame can outlast the test timeout on slow CI runners.)
    const portrait = withExifOrientation(await solidJpeg(3600, 400), 6);
    readClipboardMedia.mockResolvedValue({
      kind: 'image',
      bytes: portrait,
      mimeType: 'image/jpeg',
    });

    const { store, pasteImage } = createPasteHarness();
    await pasteImage();

    const att = store.get(1);
    if (att?.kind !== 'image') throw new Error('expected image attachment');
    expect(att.original?.width).toBe(400);
    expect(att.original?.height).toBe(3600);
    // The compressed attachment itself keeps the portrait aspect.
    expect(att.width).toBeLessThan(att.height);
    await unlink(att.original!.path!).catch(() => undefined);
  }, 15_000);

  it('stores display-space dimensions for an EXIF-rotated untouched paste', async () => {
    // Within budgets → sent byte-for-byte, but the placeholder and metadata
    // must still describe the display (rotated) space.
    const portrait = withExifOrientation(await solidJpeg(120, 80), 6);
    readClipboardMedia.mockResolvedValue({
      kind: 'image',
      bytes: portrait,
      mimeType: 'image/jpeg',
    });

    const { store, pasteImage } = createPasteHarness();
    await pasteImage();

    const att = store.get(1);
    if (att?.kind !== 'image') throw new Error('expected image attachment');
    expect(att.bytes).toBe(portrait); // fast path — untouched
    expect(att.original).toBeUndefined();
    expect(att.width).toBe(80);
    expect(att.height).toBe(120);
    expect(att.placeholder).toContain('80×120');
  });

  it('emits image_compress telemetry tagged tui_paste through host.track', async () => {
    const big = await solidPng(3600, 1800);
    readClipboardMedia.mockResolvedValue({ kind: 'image', bytes: big, mimeType: 'image/png' });

    const { track, pasteImage } = createPasteHarness();
    await pasteImage();

    const compressCalls = track.mock.calls.filter(([event]) => event === 'image_compress');
    expect(compressCalls).toHaveLength(1);
    const props = compressCalls[0]![1] as Record<string, unknown>;
    expect(props['source']).toBe('tui_paste');
    expect(props['outcome']).toBe('compressed');
  });

  it('uploads final bytes with a crash-recovery TTL while the staging lease owns normal cleanup', async () => {
    const small = await solidPng(80, 80);
    readClipboardMedia.mockResolvedValue({ kind: 'image', bytes: small, mimeType: 'image/png' });
    const uploadFile = uploadFileMock('file-1');

    const { store, pasteImage } = createPasteHarness({ uploadFile });
    await pasteImage();

    const att = store.get(1);
    if (att?.kind !== 'image') throw new Error('expected image attachment');
    expect(att.fileId).toBe('file-1');
    expect(att.fileExpiresAt).toBe(Date.parse('2030-01-02T03:04:05.000Z'));
    expect(uploadFile).toHaveBeenCalledTimes(1);
    const [data, opts] = uploadFile.mock.calls[0]!;
    expect(new Uint8Array(data)).toEqual(small);
    expect(opts).toEqual({
      name: 'pasted-image.png',
      mimeType: 'image/png',
      expiresInSec: 60 * 60,
    });
    // The bytes stay on the attachment for the inline fallback / cache copy.
    expect(att.bytes).toBe(small);
  });

  it('uploads the compressed bytes when paste-time compression changed them (v2)', async () => {
    const big = await solidPng(3600, 1800);
    readClipboardMedia.mockResolvedValue({ kind: 'image', bytes: big, mimeType: 'image/png' });
    const uploadFile = uploadFileMock('file-9');

    const { store, pasteImage } = createPasteHarness({ uploadFile });
    await pasteImage();

    const att = store.get(1);
    if (att?.kind !== 'image') throw new Error('expected image attachment');
    expect(att.fileId).toBe('file-9');
    // The upload carries exactly what the attachment stores — the compressed
    // bytes, not the clipboard original.
    const [data] = uploadFile.mock.calls[0]!;
    expect(data).toBe(att.bytes);
    expect(att.bytes).not.toBe(big);
  });

  it('keeps the paste on the inline fallback when the daemon upload fails (v2)', async () => {
    const small = await solidPng(80, 80);
    readClipboardMedia.mockResolvedValue({ kind: 'image', bytes: small, mimeType: 'image/png' });
    const uploadFile = vi.fn(
      async (
        _data: Uint8Array,
        _opts: { name: string; mimeType?: string; expiresInSec?: number },
      ): Promise<{ id: string }> => {
        throw new Error('daemon down');
      },
    );

    const { store, pasteImage } = createPasteHarness({ uploadFile });
    await pasteImage(); // must not throw

    const att = store.get(1);
    if (att?.kind !== 'image') throw new Error('expected image attachment');
    expect(att.fileId).toBeUndefined();
    expect(att.bytes).toBe(small);
  });

  it('settles the paste callback before the background daemon upload completes (v2)', async () => {
    const small = await solidPng(80, 80);
    readClipboardMedia.mockResolvedValue({ kind: 'image', bytes: small, mimeType: 'image/png' });
    let resolveUpload!: (meta: { id: string }) => void;
    const uploadFile = vi.fn(
      (
        _data: Uint8Array,
        _opts: { name: string; mimeType?: string; expiresInSec?: number },
      ): Promise<{ id: string }> =>
        new Promise<{ id: string }>((resolve) => {
          resolveUpload = resolve;
        }),
    );

    const { store, pasteImageRaw } = createPasteHarness({ uploadFile });
    // The handler returns once the placeholder is in the editor; the upload
    // is still unresolved here — typing is never held behind it.
    await pasteImageRaw();

    const att = store.get(1);
    if (att?.kind !== 'image') throw new Error('expected image attachment');
    expect(att.placeholder).toBe('[image #1 (80×80)]');
    expect(att.fileId).toBeUndefined();
    expect(att.pending).toBeDefined();

    resolveUpload({ id: 'file-late' });
    await att.pending;

    expect(att.fileId).toBe('file-late');
    expect(att.pending).toBeUndefined();
  });
});

describe('path-attached image ingestion', () => {
  async function noisePng(width: number, height: number): Promise<Uint8Array> {
    const image = new Jimp({ width, height, color: 0x000000ff });
    let state = 42;
    const next = (): number => {
      state = (state * 48271) % 2147483647;
      return state % 256;
    };
    const data = image.bitmap.data;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = next();
      data[i + 1] = next();
      data[i + 2] = next();
      data[i + 3] = 0xff;
    }
    return new Uint8Array(await image.getBuffer('image/png'));
  }

  it('compresses an oversized image attached by file path before storing it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-path-img-'));
    try {
      const big = await solidPng(3600, 1800);
      const file = join(dir, 'big.png');
      await writeFile(file, big);

      const harness = createPasteHarness();
      const r = await extractMediaAttachments(
        `看这个 ${file} 谢谢`,
        harness.store,
        (attachment, bytes, mime, width, height) =>
          harness.controller.prepareImageAttachment(attachment, bytes, mime, width, height),
      );

      expect(r.hasMedia).toBe(true);
      expect(r.imageAttachmentIds).toEqual([1]);
      const att = harness.store.get(1);
      if (att?.kind !== 'image') throw new Error('expected image attachment');
      // Stored metadata reflects the compressed size, mirroring the paste path.
      expect(Math.max(att.width, att.height)).toBeLessThanOrEqual(2000);
      expect(att.placeholder).toContain('2000×1000');
      const dims = parseImageMeta(att.bytes);
      expect(dims).not.toBeNull();
      expect(Math.max(dims!.width, dims!.height)).toBeLessThanOrEqual(3000);
      expect(att.original?.byteLength).toBe(big.length);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it('brings an over-budget file under IMAGE_BYTE_BUDGET', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-path-img-'));
    try {
      const huge = await noisePng(1200, 1200);
      expect(huge.length).toBeGreaterThan(IMAGE_BYTE_BUDGET);
      const file = join(dir, 'huge.png');
      await writeFile(file, huge);

      const harness = createPasteHarness();
      await extractMediaAttachments(
        `看这个 ${file}`,
        harness.store,
        (attachment, bytes, mime, width, height) =>
          harness.controller.prepareImageAttachment(attachment, bytes, mime, width, height),
      );

      const att = harness.store.get(1);
      if (att?.kind !== 'image') throw new Error('expected image attachment');
      expect(att.bytes.length).toBeLessThanOrEqual(IMAGE_BYTE_BUDGET);
      expect(att.bytes.length).toBeLessThan(huge.length);
      expect(att.original?.byteLength).toBe(huge.length);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('stores a within-budget file byte-for-byte (fast-path passthrough)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-path-img-'));
    try {
      const small = await solidPng(80, 80);
      const file = join(dir, 'small.png');
      await writeFile(file, small);

      const harness = createPasteHarness();
      await extractMediaAttachments(
        `看这个 ${file}`,
        harness.store,
        (attachment, bytes, mime, width, height) =>
          harness.controller.prepareImageAttachment(attachment, bytes, mime, width, height),
      );

      const att = harness.store.get(1);
      if (att?.kind !== 'image') throw new Error('expected image attachment');
      expect(att.width).toBe(80);
      expect(att.height).toBe(80);
      expect(new Uint8Array(att.bytes)).toEqual(small);
      expect(att.original).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('drag & drop image path attachment', () => {
  it('attaches a dropped image file immediately and inserts its placeholder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-drop-img-'));
    try {
      const small = await solidPng(80, 80);
      const file = join(dir, 'drop.png');
      await writeFile(file, small);

      const harness = createPasteHarness();
      const editor = harness.editor as unknown as {
        insertTextAtCursor: ReturnType<typeof vi.fn>;
      };
      const handler = harness.editor['onPasteImagePath'] as (path: string) => boolean;
      if (handler === undefined) throw new Error('onPasteImagePath handler not installed');

      const handled = handler(file);
      expect(handled).toBe(true);

      const att = harness.store.get(1);
      if (att?.kind !== 'image') throw new Error('expected image attachment');
      expect(att.width).toBe(80);
      expect(att.height).toBe(80);
      expect(editor.insertTextAtCursor).toHaveBeenCalledWith(`${att.placeholder} `);
      if (att.pending !== undefined) await att.pending;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns false for a non-image file so the path stays as text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-drop-img-'));
    try {
      const file = join(dir, 'note.txt');
      await writeFile(file, 'hello');

      const harness = createPasteHarness();
      const handler = harness.editor['onPasteImagePath'] as (path: string) => boolean;
      if (handler === undefined) throw new Error('onPasteImagePath handler not installed');

      expect(handler(file)).toBe(false);
      expect(harness.store.size()).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns false for a missing file', () => {
    const harness = createPasteHarness();
    const handler = harness.editor['onPasteImagePath'] as (path: string) => boolean;
    if (handler === undefined) throw new Error('onPasteImagePath handler not installed');

    expect(handler(join(tmpdir(), 'does-not-exist.png'))).toBe(false);
    expect(harness.store.size()).toBe(0);
  });

  it('refuses to attach in bash mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-drop-img-'));
    try {
      const small = await solidPng(80, 80);
      const file = join(dir, 'drop.png');
      await writeFile(file, small);

      const harness = createPasteHarness();
      const editor = harness.editor as unknown as { inputMode: 'prompt' | 'bash' };
      editor.inputMode = 'bash';
      const handler = harness.editor['onPasteImagePath'] as (path: string) => boolean;
      if (handler === undefined) throw new Error('onPasteImagePath handler not installed');

      expect(handler(file)).toBe(false);
      expect(harness.store.size()).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('clipboard video paste upload', () => {
  beforeEach(() => {
    readClipboardMedia.mockReset();
  });

  async function withSourceVideo(run: (sourcePath: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'paste-video-'));
    try {
      const sourcePath = join(dir, 'clip.mp4');
      await writeFile(sourcePath, 'video-bytes');
      await run(sourcePath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('uploads the pasted video to the daemon file store (v2)', async () => {
    await withSourceVideo(async (sourcePath) => {
      readClipboardMedia.mockResolvedValue({
        kind: 'video',
        mimeType: 'video/mp4',
        filename: 'clip.mp4',
        sourcePath,
      });
      const uploadFile = uploadFileMock('file-v1');

      const { store, pasteImage } = createPasteHarness({ uploadFile });
      await pasteImage();

      const att = store.get(1);
      if (att?.kind !== 'video') throw new Error('expected video attachment');
      expect(att.placeholder).toBe('[video #1 clip.mp4]');
      expect(att.fileId).toBe('file-v1');
      expect(att.fileExpiresAt).toBe(Date.parse('2030-01-02T03:04:05.000Z'));
      expect(att.pending).toBeUndefined();
      const [data, opts] = uploadFile.mock.calls[0]!;
      expect(new Uint8Array(data)).toEqual(new TextEncoder().encode('video-bytes'));
      expect(opts).toEqual({ name: 'clip.mp4', mimeType: 'video/mp4', expiresInSec: 60 * 60 });
    });
  });

  it('settles the paste callback before the background upload completes (v2)', async () => {
    await withSourceVideo(async (sourcePath) => {
      readClipboardMedia.mockResolvedValue({
        kind: 'video',
        mimeType: 'video/mp4',
        filename: 'clip.mp4',
        sourcePath,
      });
      let resolveUpload!: (meta: { id: string }) => void;
      const uploadFile = vi.fn(
        (
          _data: Uint8Array,
          _opts: { name: string; mimeType?: string; expiresInSec?: number },
        ): Promise<{ id: string }> =>
          new Promise<{ id: string }>((resolve) => {
            resolveUpload = resolve;
          }),
      );

      const { store, pasteImageRaw } = createPasteHarness({ uploadFile });
      // The handler returns once the placeholder is in the editor; the upload
      // is still unresolved here — typing is never held behind it.
      await pasteImageRaw();

      const att = store.get(1);
      if (att?.kind !== 'video') throw new Error('expected video attachment');
      expect(att.fileId).toBeUndefined();
      expect(att.pending).toBeDefined();

      // The upload starts once the source file has been read in the
      // background; only then can it be resolved.
      await vi.waitFor(() => {
        expect(uploadFile).toHaveBeenCalled();
      });
      resolveUpload({ id: 'file-vlate' });
      await att.pending;

      expect(att.fileId).toBe('file-vlate');
      expect(att.pending).toBeUndefined();
    });
  });

  it('leaves the video without a fileId when the daemon upload fails (v2)', async () => {
    await withSourceVideo(async (sourcePath) => {
      readClipboardMedia.mockResolvedValue({
        kind: 'video',
        mimeType: 'video/mp4',
        filename: 'clip.mp4',
        sourcePath,
      });
      const uploadFile = vi.fn(async (): Promise<{ id: string }> => {
        throw new Error('daemon down');
      });

      const { store, pasteImage } = createPasteHarness({ uploadFile });
      await pasteImage(); // must not throw

      const att = store.get(1);
      if (att?.kind !== 'video') throw new Error('expected video attachment');
      expect(att.fileId).toBeUndefined();
      expect(att.pending).toBeUndefined();
    });
  });

  it('leaves the video without a fileId when the source file vanished (v2)', async () => {
    readClipboardMedia.mockResolvedValue({
      kind: 'video',
      mimeType: 'video/mp4',
      filename: 'clip.mp4',
      sourcePath: '/tmp/kimi-paste-vanished-source.mp4',
    });
    const uploadFile = uploadFileMock('file-v1');

    const { store, pasteImage } = createPasteHarness({ uploadFile });
    await pasteImage();

    expect(uploadFile).not.toHaveBeenCalled();
    const att = store.get(1);
    if (att?.kind !== 'video') throw new Error('expected video attachment');
    expect(att.fileId).toBeUndefined();
  });
});
