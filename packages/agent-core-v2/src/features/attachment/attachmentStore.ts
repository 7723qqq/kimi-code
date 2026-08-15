/**
 * `attachment` domain — content-addressed object storage mechanics.
 *
 * DI-free store over a root directory: objects live at
 * `<root>/objects/<xx>/<sha256>` (first two hex chars as the fan-out
 * directory), published atomically with a directory sync so a durable
 * reference is never reported before its entry reaches storage. Writes are
 * idempotent by digest — re-saving identical bytes is a no-op.
 *
 * Ported from deepseek-harness `attachment/attachment-local/src/store.ts`
 * (MIT).
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AttachmentError } from './errors';
import { AttachmentId, type ImageAttachmentRef } from './types';

const ID_PATTERN = /^sha256:([a-f0-9]{64})$/;

/** Digest the payload as `sha256:<hex>`. */
export function digest(data: Uint8Array): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

/** Strip local path information from a caller-supplied display name. */
export function displayName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  // Strip both separator styles by hand: a POSIX host treats `\` as an
  // ordinary character, so path.basename would keep a Windows client's full
  // local path and leak it into the reference.
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1);
  // eslint-disable-next-line unicorn/escape-case -- the literal backslash names the Windows separator.
  const clean = leaf
    .replaceAll(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, 255);
  return clean === '' ? undefined : clean;
}

/** The on-disk object path for one sha256 digest. */
export function objectPath(root: string, sha256: string): string {
  return join(root, 'objects', sha256.slice(0, 2), sha256);
}

/** Extract the bare sha256 from a reference id, rejecting malformed ids. */
export function requireSha256(ref: ImageAttachmentRef | string): string {
  const id = typeof ref === 'string' ? ref : String(ref.attachmentId);
  const match = ID_PATTERN.exec(id);
  if (match?.[1] === undefined) {
    throw new AttachmentError('Attachment reference is invalid.', 'INVALID_ATTACHMENT_REF');
  }
  return match[1];
}

/**
 * Make a directory's entries durable. A synced file alone does not survive a
 * crash when its directory entry never reached storage, so the publication
 * directory is synced before a durable reference is reported.
 * @param path - the directory to sync.
 */
async function syncDirectory(path: string): Promise<void> {
  // Windows cannot open directory handles; NTFS metadata journaling owns
  // entry durability there.
  if (process.platform === 'win32') return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Durably store one object, deduplicating by digest.
 * @param root - the attachment root directory.
 * @param data - the payload to store.
 * @returns the content-addressed id.
 */
export async function saveObject(root: string, data: Uint8Array): Promise<AttachmentId> {
  const id = digest(data);
  const sha = id.slice('sha256:'.length);
  const dir = join(root, 'objects', sha.slice(0, 2));
  const path = objectPath(root, sha);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    // Exclusive create: a pre-existing object is either ours (no-op) or a
    // planted file (fail) — the digest name makes the two indistinguishable,
    // so any existing path is treated as the same content.
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    await syncDirectory(dir);
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
    // Already stored; verify the existing object matches the digest.
  }
  return AttachmentId(id);
}

/**
 * Read a stored object back.
 * @param root - the attachment root directory.
 * @param attachmentId - the reference to read.
 * @returns the stored bytes; rejects when absent or unreadable.
 */
export async function readObject(root: string, attachmentId: AttachmentId): Promise<Uint8Array> {
  const sha = requireSha256(attachmentId);
  return new Uint8Array(await readFile(objectPath(root, sha)));
}
