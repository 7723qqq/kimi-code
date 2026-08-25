import { mkdtempSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDaemonFileUrl } from '@moonshot-ai/kimi-code-sdk';
import { describe, it, expect } from 'vitest';

import { KIMI_CODE_HOME_ENV } from '#/constant/app';
import { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';
import {
  extractMediaAttachments,
  resolveOriginalCaptions,
  rewriteMediaPlaceholders,
} from '#/tui/utils/image-placeholder';
import { getCacheDir } from '#/utils/paths';

function storeWith(
  bytes: Uint8Array,
  width = 640,
  height = 480,
): { store: ImageAttachmentStore; placeholder: string } {
  const store = new ImageAttachmentStore();
  const att = store.addImage(bytes, 'image/png', width, height);
  return { store, placeholder: att.placeholder };
}

/** Point `getCacheDir()` at a fresh temp home for the duration of a test. */
function setupTempCache(): { cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'kimi-home-'));
  const prev = process.env[KIMI_CODE_HOME_ENV];
  process.env[KIMI_CODE_HOME_ENV] = home;
  return {
    cleanup: () => {
      if (prev === undefined) delete process.env[KIMI_CODE_HOME_ENV];
      else process.env[KIMI_CODE_HOME_ENV] = prev;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'kimi-src-'));
}

type VideoUrlPart = { type: 'video_url'; videoUrl: { url: string } };

describe('extractMediaAttachments', () => {
  it('returns no parts and hasMedia=false for plain text', () => {
    const store = new ImageAttachmentStore();
    const r = extractMediaAttachments('hello world', store);
    expect(r.hasMedia).toBe(false);
    expect(r.parts).toEqual([]);
    expect(r.imageAttachmentIds).toEqual([]);
    expect(r.videoAttachmentIds).toEqual([]);
  });

  it('extracts a single matching placeholder into an image content part', () => {
    const { store, placeholder } = storeWith(new Uint8Array([0xaa, 0xbb]));
    const r = extractMediaAttachments(`describe ${placeholder} please`, store);
    expect(r.hasMedia).toBe(true);
    expect(r.imageAttachmentIds).toEqual([1]);
    expect(r.parts).toEqual([
      { type: 'text', text: 'describe ' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } },
      { type: 'text', text: ' please' },
    ]);
  });

  it('keeps matched-placeholder order with multiple images', () => {
    const store = new ImageAttachmentStore();
    const a = store.addImage(new Uint8Array([1]), 'image/png', 10, 10);
    const b = store.addImage(new Uint8Array([2]), 'image/png', 20, 20);
    const text = `first ${a.placeholder} then ${b.placeholder} end`;
    const r = extractMediaAttachments(text, store);
    expect(r.imageAttachmentIds).toEqual([1, 2]);
    expect(r.parts).toEqual([
      { type: 'text', text: 'first ' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AQ==' } },
      { type: 'text', text: ' then ' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,Ag==' } },
      { type: 'text', text: ' end' },
    ]);
  });

  it('keeps matched-placeholder order with mixed image and video attachments', () => {
    const store = new ImageAttachmentStore();
    const img = store.addImage(new Uint8Array([1]), 'image/png', 10, 10);
    const vid = store.addVideo('video/quicktime', '/tmp/clip.mov');
    store.completeVideo(vid, { fileId: 'file-v1' });
    const text = `first ${img.placeholder} then ${vid.placeholder} end`;
    const r = extractMediaAttachments(text, store);
    expect(r.imageAttachmentIds).toEqual([1]);
    expect(r.videoAttachmentIds).toEqual([2]);
    expect(r.parts).toEqual([
      { type: 'text', text: 'first ' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AQ==' } },
      { type: 'text', text: ' then ' },
      { type: 'video_url', videoUrl: { url: 'kimi-file://file-v1' } },
      { type: 'text', text: ' end' },
    ]);
  });

  it('leaves unresolved (typed by hand) placeholders as literal text', () => {
    const store = new ImageAttachmentStore();
    const r = extractMediaAttachments('try [image #999 (1×1)] and [video #42 clip.mov] now', store);
    expect(r.hasMedia).toBe(false);
    expect(r.parts).toEqual([]);
  });

  it('uses pasted image bytes in data URLs', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { store, placeholder } = storeWith(bytes);
    const r = extractMediaAttachments(placeholder, store);
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0]).toEqual({
      type: 'image_url',
      imageUrl: { url: 'data:image/png;base64,iVBORw==' },
    });
  });

  it('keeps the video label (including special chars) in the slash-args cache path', () => {
    const { cleanup } = setupTempCache();
    const srcDir = makeTempDir();
    try {
      const srcVideo = join(srcDir, 'source.mp4');
      writeFileSync(srcVideo, 'x');
      const store = new ImageAttachmentStore();
      // The filename drives the cache label; `&` is a valid path char the cache
      // copy keeps verbatim in the tag form (slash-args channel only — prompt
      // parts never stage a cache copy).
      const att = store.addVideo('video/mp4', srcVideo, 'a&b.mp4');
      const r = rewriteMediaPlaceholders(att.placeholder, store, 'tag');
      // The tag form XML-escapes the label (`&` → `&amp;`), the plain form
      // strips it from the cache name instead.
      expect(r.text).toContain('a&amp;b.mp4');
      expect(r.videoAttachmentIds).toEqual([1]);
    } finally {
      cleanup();
      rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('emits a bare kimi-file video_url part for an uploaded video', () => {
    const { cleanup } = setupTempCache();
    try {
      const store = new ImageAttachmentStore();
      const att = store.addVideo('video/mp4', '/tmp/sample.mp4');
      store.completeVideo(att, { fileId: 'file-v1' });
      const r = extractMediaAttachments(att.placeholder, store);
      expect(r.hasMedia).toBe(true);
      expect(r.videoAttachmentIds).toEqual([1]);
      expect(r.parts).toHaveLength(1);
      const part = r.parts[0] as VideoUrlPart;
      expect(part.type).toBe('video_url');
      // No cache copy and no `?path=`: the engine's prompt intake
      // materializes the session copy and rewrites the reference — the part
      // is self-contained.
      expect(parseDaemonFileUrl(part.videoUrl.url)).toEqual({ fileId: 'file-v1' });
      expect(existsSync(getCacheDir())).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('refuses a video whose upload is still in flight', () => {
    const store = new ImageAttachmentStore();
    const att = store.addVideo('video/mp4', '/tmp/sample.mp4');
    att.pending = new Promise<void>(() => undefined); // never settles
    expect(() => extractMediaAttachments(att.placeholder, store)).toThrow(/still uploading/);
  });

  it('refuses a video whose upload failed or is missing', () => {
    const store = new ImageAttachmentStore();
    const att = store.addVideo('video/mp4', '/tmp/sample.mp4');
    expect(() => extractMediaAttachments(att.placeholder, store)).toThrow(
      /could not be uploaded/,
    );
  });

  it('inserts a compression caption before an image that was compressed at paste time', () => {
    const store = new ImageAttachmentStore();
    const att = store.addImage(new Uint8Array([1, 2, 3]), 'image/png', 2000, 2000, {
      path: '/tmp/kimi-code-original-images/abc.png',
      width: 2600,
      height: 2600,
      byteLength: 123456,
      mime: 'image/png',
    });

    // Extraction never authors captions; dispatch-time resolution does, once
    // the session (and its media-originals dir) is known.
    const extracted = extractMediaAttachments(`look ${att.placeholder}`, store);
    const parts = resolveOriginalCaptions(
      extracted.parts,
      extracted.imageAttachmentIds,
      store,
      undefined,
    );

    expect(parts).toHaveLength(3);
    // Leading text survives; the caption is authored before the image part.
    expect(parts[0]).toEqual({ type: 'text', text: 'look ' });
    const caption = parts[1];
    if (caption?.type !== 'text') throw new Error('expected leading text part');
    expect(caption.text).toContain('Image compressed');
    expect(caption.text).toContain('2600x2600');
    expect(caption.text).toContain('/tmp/kimi-code-original-images/abc.png');
    expect(parts[2]).toEqual({
      type: 'image_url',
      imageUrl: { url: 'data:image/png;base64,AQID' },
    });
  });

  it('notes an unpreserved original when persistence failed at paste time', () => {
    const store = new ImageAttachmentStore();
    const att = store.addImage(new Uint8Array([1]), 'image/png', 2000, 2000, {
      path: undefined,
      width: 2600,
      height: 2600,
      byteLength: 123456,
      mime: 'image/png',
    });

    const extracted = extractMediaAttachments(att.placeholder, store);
    const parts = resolveOriginalCaptions(
      extracted.parts,
      extracted.imageAttachmentIds,
      store,
      undefined,
    );

    const caption = parts[0];
    if (caption?.type !== 'text') throw new Error('expected leading text part');
    expect(caption.text).toMatch(/not preserved/i);
  });

  it('adds no caption for an uncompressed image attachment', () => {
    const { store, placeholder } = storeWith(new Uint8Array([0xaa]));
    const r = extractMediaAttachments(placeholder, store);
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0]?.type).toBe('image_url');
  });
});

describe('rewriteMediaPlaceholders', () => {
  it('returns plain text untouched with hasMedia=false', () => {
    const store = new ImageAttachmentStore();
    const r = rewriteMediaPlaceholders('just some args', store);
    expect(r.text).toBe('just some args');
    expect(r.hasMedia).toBe(false);
    expect(r.imageAttachmentIds).toEqual([]);
    expect(r.videoAttachmentIds).toEqual([]);
  });

  it('rewrites an image placeholder into a cache-path image tag', () => {
    const { cleanup } = setupTempCache();
    try {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const { store, placeholder } = storeWith(bytes);
      const r = rewriteMediaPlaceholders(`look at ${placeholder} please`, store);
      expect(r.hasMedia).toBe(true);
      expect(r.imageAttachmentIds).toEqual([1]);
      const m = /^look at <image path="([^"]+)"><\/image> please$/.exec(r.text);
      if (!m) throw new Error(`no image tag found in: ${r.text}`);
      expect(m[1]!.startsWith(getCacheDir())).toBe(true);
      expect(m[1]!.endsWith('.png')).toBe(true);
      expect(new Uint8Array(readFileSync(m[1]!))).toEqual(bytes);
    } finally {
      cleanup();
    }
  });

  it('rewrites a video placeholder into a cache-path video tag', () => {
    const { cleanup } = setupTempCache();
    const srcDir = makeTempDir();
    try {
      const srcVideo = join(srcDir, 'clip.mov');
      writeFileSync(srcVideo, 'video-bytes');
      const store = new ImageAttachmentStore();
      const att = store.addVideo('video/quicktime', srcVideo);
      const r = rewriteMediaPlaceholders(att.placeholder, store);
      expect(r.hasMedia).toBe(true);
      expect(r.videoAttachmentIds).toEqual([1]);
      const m = /<video path="([^"]+)"><\/video>/.exec(r.text);
      if (!m) throw new Error(`no video tag found in: ${r.text}`);
      expect(m[1]!.startsWith(getCacheDir())).toBe(true);
      expect(readFileSync(m[1]!, 'utf8')).toBe('video-bytes');
    } finally {
      cleanup();
      rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('leaves unresolved (typed by hand) placeholders as literal text', () => {
    const store = new ImageAttachmentStore();
    const text = 'try [image #999 (1×1)] and [video #42 clip.mov] now';
    const r = rewriteMediaPlaceholders(text, store);
    expect(r.text).toBe(text);
    expect(r.hasMedia).toBe(false);
  });

  it('preserves surrounding text verbatim across multiple attachments', () => {
    const { cleanup } = setupTempCache();
    try {
      const store = new ImageAttachmentStore();
      const a = store.addImage(new Uint8Array([1]), 'image/png', 10, 10);
      const b = store.addImage(new Uint8Array([2]), 'image/jpeg', 20, 20);
      const r = rewriteMediaPlaceholders(
        `first ${a.placeholder}   then ${b.placeholder} end`,
        store,
      );
      expect(r.imageAttachmentIds).toEqual([1, 2]);
      const tags = [...r.text.matchAll(/<image path="([^"]+)"><\/image>/g)];
      expect(tags).toHaveLength(2);
      expect(r.text.startsWith('first <image path=')).toBe(true);
      expect(r.text).toContain('>   then <image path=');
      expect(r.text.endsWith('> end')).toBe(true);
      expect(new Uint8Array(readFileSync(tags[0]![1]!))).toEqual(new Uint8Array([1]));
      expect(new Uint8Array(readFileSync(tags[1]![1]!))).toEqual(new Uint8Array([2]));
    } finally {
      cleanup();
    }
  });

  it("rewrites an image placeholder into an escape-proof plain reference in 'plain' style", () => {
    const { cleanup } = setupTempCache();
    try {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const { store, placeholder } = storeWith(bytes);
      const r = rewriteMediaPlaceholders(`look at ${placeholder}`, store, 'plain');
      expect(r.hasMedia).toBe(true);
      expect(r.imageAttachmentIds).toEqual([1]);
      // Skill args pass through XML escaping, so the reference must not
      // contain any tag/attribute boundary characters.
      expect(r.text).not.toMatch(/[<>&"]/);
      const m = /^look at Attached image file: (\S+) \(open it with Read\)$/.exec(r.text);
      if (!m) throw new Error(`no plain reference found in: ${r.text}`);
      expect(m[1]!.startsWith(getCacheDir())).toBe(true);
      expect(new Uint8Array(readFileSync(m[1]!))).toEqual(bytes);
    } finally {
      cleanup();
    }
  });

  it("rewrites a video placeholder into an escape-proof plain reference in 'plain' style", () => {
    const { cleanup } = setupTempCache();
    const srcDir = makeTempDir();
    try {
      const srcVideo = join(srcDir, 'clip.mov');
      writeFileSync(srcVideo, 'video-bytes');
      const store = new ImageAttachmentStore();
      const att = store.addVideo('video/quicktime', srcVideo);
      const r = rewriteMediaPlaceholders(att.placeholder, store, 'plain');
      expect(r.hasMedia).toBe(true);
      expect(r.videoAttachmentIds).toEqual([1]);
      expect(r.text).not.toMatch(/[<>&"]/);
      const m = /^Attached video file: (\S+) \(open it with Read\)$/.exec(r.text);
      if (!m) throw new Error(`no plain reference found in: ${r.text}`);
      expect(readFileSync(m[1]!, 'utf8')).toBe('video-bytes');
    } finally {
      cleanup();
      rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('sanitizes XML boundary chars out of plain-style video cache names', () => {
    const { cleanup } = setupTempCache();
    const srcDir = makeTempDir();
    try {
      // The video label keeps the original filename, and sanitizeVideoLabel
      // allows `<>&"`; skill args are XML-escaped, so the plain reference
      // would point at a path that no longer matches the file on disk.
      // (`<`, `>`, `"` are illegal on Windows, so the fixture sticks to `&`,
      // which is still an XML boundary character on every platform.)
      const srcVideo = join(srcDir, 'clip&1.mov');
      writeFileSync(srcVideo, 'video-bytes');
      const store = new ImageAttachmentStore();
      const att = store.addVideo('video/quicktime', srcVideo);
      const r = rewriteMediaPlaceholders(att.placeholder, store, 'plain');
      expect(r.text).not.toMatch(/[<>&"]/);
      const m = /^Attached video file: (\S+) \(open it with Read\)$/.exec(r.text);
      if (!m) throw new Error(`no plain reference found in: ${r.text}`);
      expect(readFileSync(m[1]!, 'utf8')).toBe('video-bytes');
    } finally {
      cleanup();
      rmSync(srcDir, { recursive: true, force: true });
    }
  });
});

describe('extractMediaAttachments: bare image paths', () => {
  const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  it('attaches an absolute POSIX image path and replaces it inline', () => {
    const dir = makeTempDir();
    const file = join(dir, 'sample.png');
    writeFileSync(file, PNG_1X1);
    const store = new ImageAttachmentStore();
    const r = extractMediaAttachments(`看这个 ${file} 谢谢`, store);
    expect(r.hasMedia).toBe(true);
    expect(r.imageAttachmentIds).toEqual([1]);
    expect(r.parts.some((p) => p.type === 'image_url')).toBe(true);
    expect(JSON.stringify(r.parts)).not.toContain('sample.png');
  });

  it('converts a quoted path containing spaces', () => {
    const dir = join(makeTempDir(), 'with space');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'wx shot.png');
    writeFileSync(file, PNG_1X1);
    const store = new ImageAttachmentStore();
    const r = extractMediaAttachments(`"${file}"`, store);
    expect(r.hasMedia).toBe(true);
    expect(r.imageAttachmentIds).toEqual([1]);
  });

  it('leaves a Windows path with no backing file as literal text', () => {
    const store = new ImageAttachmentStore();
    const text = String.raw`看 D:\微信聊天数据\temp\a7d0eaaa.png 这张图`;
    const r = extractMediaAttachments(text, store);
    expect(r.hasMedia).toBe(false);
    expect(r.parts).toEqual([]);
    expect(text).toContain('D:\\微信聊天数据');
  });

  it('reuses one attachment when the same path appears twice', () => {
    const dir = makeTempDir();
    const file = join(dir, 'dup.png');
    writeFileSync(file, PNG_1X1);
    const store = new ImageAttachmentStore();
    const r = extractMediaAttachments(`对比 ${file} 和 ${file} 的差异`, store);
    // Both spans resolve to the SAME stored attachment (dedupe) — two
    // references, one set of bytes; without dedupe this would be [1, 2].
    expect(r.imageAttachmentIds).toEqual([1, 1]);
    expect(r.parts.filter((p) => p.type === 'image_url')).toHaveLength(2);
  });
});
