/**
 * Scenario: the `attachment` capability — content-addressed image storage.
 *
 * Exercises digest addressing/deduplication, display-name sanitization, the
 * admission policy (byte/pixel limits, media-type verification, full
 * decode), and the App-scope service round-trip against a scratch root.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { IConfigService } from '#/app/config/config';
import { AttachmentService } from '#/features/attachment/attachmentService';
import { AttachmentId } from '#/features/attachment/types';
import { digest, displayName, objectPath, saveObject, readObject } from '#/features/attachment/attachmentStore';

const scratchDirs: string[] = [];

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-attachment-test-'));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  scratchDirs.splice(0);
});

function configStub(root: string): IConfigService {
  return {
    get: <T>(section: string): T | undefined =>
      section === 'attachment' ? ({ root } as T) : undefined,
  } as unknown as IConfigService;
}

function makeService(root: string): AttachmentService {
  return new AttachmentService(configStub(root));
}

/** A minimal valid 1x1 transparent PNG. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('attachmentStore', () => {
  it('digests content as sha256', () => {
    expect(digest(new Uint8Array([1, 2, 3]))).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('stores and reads objects by content address', async () => {
    const root = scratchDir();
    const id = await saveObject(root, new Uint8Array([1, 2, 3]));
    const read = await readObject(root, id);
    expect([...read]).toEqual([1, 2, 3]);
  });

  it('deduplicates identical payloads', async () => {
    const root = scratchDir();
    const data = new Uint8Array([7, 8, 9]);
    const first = await saveObject(root, data);
    const second = await saveObject(root, data);
    expect(first).toBe(second);
    expect(objectPath(root, first.slice(7))).toContain('objects');
  });

  it('rejects malformed attachment ids', async () => {
    const root = scratchDir();
    await expect(readObject(root, AttachmentId('bogus'))).rejects.toThrowError(/invalid/i);
  });

  it('sanitizes display names of path information', () => {
    expect(displayName('C:\\Users\\x\\photo.png')).toBe('photo.png');
    expect(displayName('/home/user/photo.png')).toBe('photo.png');
    expect(displayName('   ')).toBeUndefined();
    expect(displayName(undefined)).toBeUndefined();
  });
});

describe('AttachmentService', () => {
  it('saves a valid PNG and reads it back with verified metadata', async () => {
    const service = makeService(scratchDir());
    const ref = await service.saveImage({
      data: PNG_1X1,
      mediaType: 'image/png',
      name: 'C:\\tmp\\dot.png',
    });
    expect(ref.mediaType).toBe('image/png');
    expect(ref.width).toBe(1);
    expect(ref.height).toBe(1);
    expect(ref.bytes).toBe(PNG_1X1.byteLength);
    expect(ref.name).toBe('dot.png');
    expect(String(ref.attachmentId)).toMatch(/^sha256:/);

    const stored = await service.readImage(ref.attachmentId);
    // The name is caller-supplied metadata, not part of the stored object;
    // reads re-derive everything else from the bytes.
    expect(stored.ref).toEqual({ ...ref, name: undefined });
    expect(Buffer.from(stored.data).equals(PNG_1X1)).toBe(true);
  });

  it('deduplicates by content across saves', async () => {
    const service = makeService(scratchDir());
    const first = await service.saveImage({ data: PNG_1X1, mediaType: 'image/png' });
    const second = await service.saveImage({ data: PNG_1X1, mediaType: 'image/png' });
    expect(first.attachmentId).toBe(second.attachmentId);
  });

  it('rejects a declared media type that does not match the bytes', async () => {
    const service = makeService(scratchDir());
    await expect(
      service.saveImage({ data: PNG_1X1, mediaType: 'image/jpeg' }),
    ).rejects.toThrowError(/does not match/i);
  });

  it('rejects malformed image data', async () => {
    const service = makeService(scratchDir());
    await expect(
      service.saveImage({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }),
    ).rejects.toThrowError(/unsupported or malformed/i);
  });

  it('rejects empty images', async () => {
    const service = makeService(scratchDir());
    await expect(
      service.saveImage({ data: new Uint8Array(0), mediaType: 'image/png' }),
    ).rejects.toThrowError(/empty/i);
  });

  it('rejects oversized images by byte limit', async () => {
    const root = scratchDir();
    const service = new AttachmentService({
      get: <T>(section: string): T | undefined =>
        section === 'attachment'
          ? ({ root, limits: { maxImageBytes: 10 } } as T)
          : undefined,
    } as unknown as IConfigService);
    await expect(
      service.saveImage({ data: PNG_1X1, mediaType: 'image/png' }),
    ).rejects.toThrowError(/byte limit/i);
  });
});
