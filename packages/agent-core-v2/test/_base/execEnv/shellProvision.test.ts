import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type ShellPayloadPin,
  pathExists,
  readShellPayloadStatus,
  shellPayloadInstallDir,
  shellPayloadsDir,
} from '#/_base/execEnv/shellPayload';
import {
  ShellPayloadExtractError,
  ShellPayloadIntegrityError,
  type ShellProvisionDeps,
  applyDownloadMirror,
  downloadShellPayloadArchive,
  provisionShellPayloadWithPin,
  resolveDownloadCandidates,
} from '#/_base/execEnv/shellProvision';

const EXE_CONTENT = 'fake-payload-exe';

function testPin(overrides: Partial<ShellPayloadPin> = {}): ShellPayloadPin {
  return {
    kind: 'pwsh',
    version: '9.9.9-test',
    url: 'https://example.com/payload.zip',
    sha256: createHash('sha256').update('payload-bytes').digest('hex'),
    archive: 'zip',
    exeRelPath: 'nested/pwsh.exe',
    license: 'MIT — source: https://example.com/src',
    source: 'https://example.com/release',
    ...overrides,
  };
}

function depsWith(
  download: ShellProvisionDeps['download'],
  extract: ShellProvisionDeps['extract'] = async (_archive, _archiveKind, destDir) => {
    await mkdir(join(destDir, 'nested'), { recursive: true });
    await writeFile(join(destDir, 'nested', 'pwsh.exe'), EXE_CONTENT);
  },
): ShellProvisionDeps {
  return { download, extract, now: () => new Date('2026-10-30T00:00:00.000Z') };
}

let kimiHome: string;

beforeEach(async () => {
  kimiHome = await mkdtemp(join(tmpdir(), 'shell-provision-test-'));
});

afterEach(async () => {
  await rm(kimiHome, { recursive: true, force: true });
});

describe('applyDownloadMirror', () => {
  it('returns the original url when no mirror is configured', () => {
    expect(applyDownloadMirror('https://example.com/a.zip', undefined)).toBe(
      'https://example.com/a.zip',
    );
    expect(applyDownloadMirror('https://example.com/a.zip', '  ')).toBe(
      'https://example.com/a.zip',
    );
  });

  it('prefixes the mirror base without trailing-slash duplication', () => {
    expect(applyDownloadMirror('https://example.com/a.zip', 'https://mirror.example/')).toBe(
      'https://mirror.example/https://example.com/a.zip',
    );
    expect(applyDownloadMirror('https://example.com/a.zip', 'https://mirror.example')).toBe(
      'https://mirror.example/https://example.com/a.zip',
    );
  });
});

describe('resolveDownloadCandidates', () => {
  it('lists only the official url without a mirror', () => {
    expect(resolveDownloadCandidates('https://example.com/a.zip', undefined)).toEqual([
      'https://example.com/a.zip',
    ]);
  });

  it('tries the mirror first and falls back to the official url', () => {
    expect(
      resolveDownloadCandidates('https://example.com/a.zip', 'https://mirror.example'),
    ).toEqual(['https://mirror.example/https://example.com/a.zip', 'https://example.com/a.zip']);
  });
});

describe('downloadShellPayloadArchive', () => {
  it('returns the verified archive path, hash and size', async () => {
    const pin = testPin();
    const destPath = join(kimiHome, 'payload.zip');
    const result = await downloadShellPayloadArchive(
      pin,
      destPath,
      depsWith(async (_url, dest) => {
        await writeFile(dest, 'payload-bytes');
      }),
    );
    expect(result.path).toBe(destPath);
    expect(result.sha256).toBe(pin.sha256);
    expect(result.sizeBytes).toBe('payload-bytes'.length);
  });

  it('removes the file and throws when the hash does not match', async () => {
    const pin = testPin();
    const destPath = join(kimiHome, 'payload.zip');
    const rejected: unknown = await downloadShellPayloadArchive(
      pin,
      destPath,
      depsWith(async (_url, dest) => {
        await writeFile(dest, 'tampered');
      }),
    ).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(ShellPayloadIntegrityError);
    expect(await pathExists(destPath)).toBe(false);
  });

  it('falls back to the next source when a source serves corrupt bytes', async () => {
    const pin = testPin();
    const destPath = join(kimiHome, 'payload.zip');
    const urls: string[] = [];
    const result = await downloadShellPayloadArchive(
      pin,
      destPath,
      depsWith(async (url, dest) => {
        urls.push(url);
        await writeFile(dest, url.includes('mirror') ? 'error-page' : 'payload-bytes');
      }),
      'https://mirror.example',
    );
    expect(urls).toEqual([
      'https://mirror.example/https://example.com/payload.zip',
      'https://example.com/payload.zip',
    ]);
    expect(result.source).toBe('https://example.com/payload.zip');
    expect(result.sha256).toBe(pin.sha256);
    expect(await pathExists(destPath)).toBe(true);
  });

  it('reports every source when all sources fail', async () => {
    const pin = testPin();
    const destPath = join(kimiHome, 'payload.zip');
    const rejected: unknown = await downloadShellPayloadArchive(
      pin,
      destPath,
      depsWith(async (url, dest) => {
        if (url.includes('mirror')) throw new Error('connect failed');
        await writeFile(dest, 'error-page');
      }),
      'https://mirror.example',
    ).catch((error: unknown) => error);
    expect((rejected as Error).message).toContain('download failed from every source');
    expect((rejected as Error).message).toContain('connect failed');
    expect((rejected as Error).message).toContain('sha256 mismatch');
    expect(await pathExists(destPath)).toBe(false);
  });
});

describe('provisionShellPayloadWithPin', () => {
  it('downloads, verifies, extracts and writes status', async () => {
    const pin = testPin();
    const urls: string[] = [];
    const result = await provisionShellPayloadWithPin(
      pin,
      kimiHome,
      depsWith(async (url, destPath) => {
        urls.push(url);
        await writeFile(destPath, 'payload-bytes');
      }),
    );

    expect(result.installed).toBe(true);
    expect(urls).toEqual([pin.url]);
    expect(result.status.version).toBe(pin.version);
    expect(result.status.exePath).toBe(
      join(kimiHome, 'shells', `pwsh-${pin.version}`, 'nested', 'pwsh.exe'),
    );
    expect(result.status.exeSha256).toBe(createHash('sha256').update(EXE_CONTENT).digest('hex'));
    expect(result.status.verifiedAt).toBe('2026-10-30T00:00:00.000Z');

    const stored = await readShellPayloadStatus(kimiHome, 'pwsh');
    expect(stored).toEqual(result.status);
    expect(await readFile(result.status.exePath, 'utf8')).toBe(EXE_CONTENT);
  });

  it('is idempotent for an already installed pin', async () => {
    const pin = testPin();
    let downloads = 0;
    const deps = depsWith(async (_url, destPath) => {
      downloads += 1;
      await writeFile(destPath, 'payload-bytes');
    });
    const first = await provisionShellPayloadWithPin(pin, kimiHome, deps);
    const second = await provisionShellPayloadWithPin(pin, kimiHome, deps);
    expect(first.installed).toBe(true);
    expect(second.installed).toBe(false);
    expect(second.status).toEqual(first.status);
    expect(downloads).toBe(1);
  });

  it('rejects a payload whose hash does not match the pin and leaves no residue', async () => {
    const pin = testPin();
    const rejected: unknown = await provisionShellPayloadWithPin(
      pin,
      kimiHome,
      depsWith(async (_url, destPath) => {
        await writeFile(destPath, 'tampered-bytes');
      }),
    ).catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(ShellPayloadIntegrityError);
    expect(await readShellPayloadStatus(kimiHome, 'pwsh')).toBeUndefined();
    const leftovers = await readdir(shellPayloadsDir(kimiHome));
    expect(leftovers).toEqual([]);
  });

  it('fails when the extracted archive lacks the pinned exe', async () => {
    const pin = testPin();
    const rejected: unknown = await provisionShellPayloadWithPin(
      pin,
      kimiHome,
      depsWith(
        async (_url, destPath) => {
          await writeFile(destPath, 'payload-bytes');
        },
        async () => {},
      ),
    ).catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(ShellPayloadExtractError);
    const leftovers = await readdir(shellPayloadsDir(kimiHome));
    expect(leftovers).toEqual([]);
    expect(await readShellPayloadStatus(kimiHome, 'pwsh')).toBeUndefined();
  });

  it('installs into the pinned install dir', async () => {
    const pin = testPin();
    const result = await provisionShellPayloadWithPin(
      pin,
      kimiHome,
      depsWith(async (_url, destPath) => {
        await writeFile(destPath, 'payload-bytes');
      }),
    );
    expect(result.status.exePath.startsWith(shellPayloadInstallDir(kimiHome, pin))).toBe(true);
  });
});
