import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SHELL_PAYLOAD_MANIFEST,
  ShellPayloadStatusCorruptError,
  type ShellPayloadStatus,
  findShellPayloadPin,
  hashFileSha256,
  readShellPayloadStatus,
  shellPayloadExePath,
  shellPayloadPinOf,
  shellPayloadStatusPath,
  verifyShellPayload,
  writeShellPayloadStatus,
} from '#/_base/execEnv/shellPayload';

let kimiHome: string;

beforeEach(async () => {
  kimiHome = await mkdtemp(join(tmpdir(), 'shell-payload-test-'));
});

afterEach(async () => {
  await rm(kimiHome, { recursive: true, force: true });
});

function statusFixture(overrides: Partial<ShellPayloadStatus> = {}): ShellPayloadStatus {
  return {
    kind: 'pwsh',
    version: '7.6.9',
    sha256: 'a'.repeat(64),
    exePath: join(kimiHome, 'pwsh.exe'),
    exeSha256: 'b'.repeat(64),
    verifiedAt: '2026-10-30T00:00:00.000Z',
    ...overrides,
  };
}

describe('SHELL_PAYLOAD_MANIFEST', () => {
  it('pins both payloads with verified provenance fields', () => {
    expect(SHELL_PAYLOAD_MANIFEST.map((pin) => pin.kind).sort()).toEqual(['bash', 'pwsh']);
    for (const pin of SHELL_PAYLOAD_MANIFEST) {
      expect(pin.url.startsWith('https://')).toBe(true);
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.exeRelPath.length).toBeGreaterThan(0);
      expect(pin.license.length).toBeGreaterThan(0);
      expect(pin.source.startsWith('https://')).toBe(true);
      expect(pin.version.length).toBeGreaterThan(0);
    }
  });

  it('exposes lookup with and without throwing', () => {
    expect(findShellPayloadPin('bash')?.kind).toBe('bash');
    expect(findShellPayloadPin('pwsh')?.kind).toBe('pwsh');
    expect(shellPayloadPinOf('bash').archive).toBe('self-extract-7z');
    expect(shellPayloadPinOf('pwsh').archive).toBe('zip');
  });
});

describe('hashFileSha256', () => {
  it('hashes file content with sha256', async () => {
    const file = join(kimiHome, 'payload.bin');
    await writeFile(file, 'abc');
    expect(await hashFileSha256(file)).toBe(createHash('sha256').update('abc').digest('hex'));
  });
});

describe('shell payload status file', () => {
  it('round-trips status through write and read', async () => {
    const status = statusFixture();
    await writeShellPayloadStatus(kimiHome, status);
    expect(await readShellPayloadStatus(kimiHome, 'pwsh')).toEqual(status);
    expect(await readShellPayloadStatus(kimiHome, 'bash')).toBeUndefined();
    expect(shellPayloadStatusPath(kimiHome, 'pwsh')).toBe(join(kimiHome, 'shells', 'pwsh.json'));
  });

  it('throws ShellPayloadStatusCorruptError on invalid JSON', async () => {
    await mkdir(join(kimiHome, 'shells'), { recursive: true });
    await writeFile(shellPayloadStatusPath(kimiHome, 'pwsh'), 'not json');
    const rejected: unknown = await readShellPayloadStatus(kimiHome, 'pwsh').catch(
      (error: unknown) => error,
    );
    expect(rejected).toBeInstanceOf(ShellPayloadStatusCorruptError);
  });

  it('throws ShellPayloadStatusCorruptError on wrong shape', async () => {
    await mkdir(join(kimiHome, 'shells'), { recursive: true });
    await writeFile(shellPayloadStatusPath(kimiHome, 'pwsh'), JSON.stringify({ kind: 'bash' }));
    const rejected: unknown = await readShellPayloadStatus(kimiHome, 'pwsh').catch(
      (error: unknown) => error,
    );
    expect(rejected).toBeInstanceOf(ShellPayloadStatusCorruptError);
  });
});

describe('verifyShellPayload', () => {
  it('reports missing when no status exists', async () => {
    expect(await verifyShellPayload(kimiHome, 'pwsh')).toEqual({ ok: false, reason: 'missing' });
  });

  it('reports exe-missing when the recorded exe is gone', async () => {
    await writeShellPayloadStatus(kimiHome, statusFixture());
    expect(await verifyShellPayload(kimiHome, 'pwsh')).toEqual({
      ok: false,
      reason: 'exe-missing',
    });
  });

  it('reports exe-hash-mismatch when the exe was tampered', async () => {
    const status = statusFixture();
    await writeFile(status.exePath, 'tampered');
    await writeShellPayloadStatus(kimiHome, status);
    expect(await verifyShellPayload(kimiHome, 'pwsh')).toEqual({
      ok: false,
      reason: 'exe-hash-mismatch',
    });
  });

  it('reports ok with status when exe hash matches', async () => {
    const status = statusFixture();
    await writeFile(status.exePath, 'real-exe');
    const exeSha256 = await hashFileSha256(status.exePath);
    await writeShellPayloadStatus(kimiHome, { ...status, exeSha256 });
    const result = await verifyShellPayload(kimiHome, 'pwsh');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status.exeSha256).toBe(exeSha256);
  });

  it('reports status-unreadable on corrupt status', async () => {
    await mkdir(join(kimiHome, 'shells'), { recursive: true });
    await writeFile(shellPayloadStatusPath(kimiHome, 'pwsh'), 'not json');
    expect(await verifyShellPayload(kimiHome, 'pwsh')).toEqual({
      ok: false,
      reason: 'status-unreadable',
    });
  });
});

describe('shellPayloadExePath', () => {
  it('joins install dir with the pinned relative exe path', () => {
    const pin = shellPayloadPinOf('bash');
    expect(shellPayloadExePath(kimiHome, pin)).toBe(
      join(kimiHome, 'shells', `bash-${pin.version}`, pin.exeRelPath),
    );
  });
});
