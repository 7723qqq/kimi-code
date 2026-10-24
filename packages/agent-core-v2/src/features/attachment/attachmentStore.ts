import { constants } from 'node:fs';
import { open, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { AttachmentErrors, AttachmentError } from './errors';
import { AttachmentId, type ImageAttachmentRef } from './types';

const ID_PATTERN = /^sha256:([a-f0-9]{64})$/;

export function digest(data: Uint8Array): string {
  return `sha256:${new (globalThis as unknown as { Bun: { CryptoHasher: new (algo: string) => any } }).Bun.CryptoHasher('sha256').update(data).digest('hex')}`;
}

export function displayName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1);
  // eslint-disable-next-line unicorn/escape-case -- the literal backslash names the Windows separator.
  const clean = leaf
    .replaceAll(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, 255);
  return clean === '' ? undefined : clean;
}

export function objectPath(root: string, sha256: string): string {
  return join(root, 'objects', sha256.slice(0, 2), sha256);
}

export function requireSha256(ref: ImageAttachmentRef | string): string {
  const id = typeof ref === 'string' ? ref : String(ref.attachmentId);
  const match = ID_PATTERN.exec(id);
  if (match?.[1] === undefined) {
    throw new AttachmentError(
      AttachmentErrors.codes.ATTACHMENT_INVALID_REF,
      'Attachment reference is invalid.',
    );
  }
  return match[1];
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function saveObject(root: string, data: Uint8Array): Promise<AttachmentId> {
  const id = digest(data);
  const sha = id.slice('sha256:'.length);
  const dir = join(root, 'objects', sha.slice(0, 2));
  const path = objectPath(root, sha);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    await syncDirectory(dir);
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
  }
  return AttachmentId(id);
}

export async function readObject(root: string, attachmentId: AttachmentId): Promise<Uint8Array> {
  const sha = requireSha256(attachmentId);
  return new Uint8Array(await (globalThis as unknown as { Bun: { file: (path: string) => { arrayBuffer: () => Promise<ArrayBuffer> } } }).Bun.file(objectPath(root, sha)).arrayBuffer());
}
