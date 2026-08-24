import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { SUPPORTED_TARGETS } from '../../../scripts/native/native-deps.mjs';
import { appRoot } from '../../../scripts/native/paths.mjs';

const execFileAsync = promisify(execFile);
const packageScript = resolve(appRoot, 'scripts/native/package.mjs');
const manifestScript = resolve(appRoot, 'scripts/native/produce-manifest.mjs');
const artifactsDir = resolve(appRoot, 'dist-native/artifacts');
const target = 'test-zip-artifact';
const executableName = process.platform === 'win32' ? 'kimi.exe' : 'kimi';
const fakeBinary = resolve(appRoot, 'dist-native/bin', target, executableName);

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function zipEntryNames(zipPath: string): readonly string[] {
  const zip = readFileSync(zipPath);
  const eocdOffset = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  let offset = zip.readUInt32LE(eocdOffset + 16);
  const names: string[] = [];

  for (let i = 0; i < entryCount; i += 1) {
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    names.push(zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf-8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return names;
}

function readZipEntry(zipPath: string, expectedName: string): Buffer {
  const zip = readFileSync(zipPath);
  const eocdOffset = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  let offset = zip.readUInt32LE(eocdOffset + 16);

  for (let i = 0; i < entryCount; i += 1) {
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf-8');
    if (name === expectedName) {
      return readLocalEntry(zip, localHeaderOffset, method, compressedSize);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }

  throw new Error(`zip entry not found: ${expectedName}`);
}

function readLocalEntry(
  zip: Buffer,
  localHeaderOffset: number,
  method: number,
  compressedSize: number,
): Buffer {
  expect(zip.readUInt32LE(localHeaderOffset)).toBe(0x04034b50);
  const nameLength = zip.readUInt16LE(localHeaderOffset + 26);
  const extraLength = zip.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + nameLength + extraLength;
  const compressed = zip.subarray(dataStart, dataStart + compressedSize);
  if (method === 0) return compressed;
  if (method === 8) return inflateRawSync(compressed);
  throw new Error(`unsupported zip compression method: ${String(method)}`);
}

function findEndOfCentralDirectory(zip: Buffer): number {
  for (let offset = zip.length - 22; offset >= 0; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('end of central directory not found');
}

describe('native release artifacts', () => {
  afterEach(() => {
    rmSync(resolve(appRoot, 'dist-native/bin', target), { recursive: true, force: true });
    rmSync(resolve(artifactsDir, `kimi-code-${target}.zip`), { force: true });
    rmSync(resolve(artifactsDir, `kimi-code-${target}.zip.sha256`), { force: true });
    rmSync(resolve(artifactsDir, `kimi-code-bun-${target}.zip`), { force: true });
    rmSync(resolve(artifactsDir, `kimi-code-bun-${target}.zip.sha256`), { force: true });
  });

  it('packages the native binary as a zip archive and checksums the archive', async () => {
    const binaryContent = 'native binary payload\n';
    mkdirSync(resolve(appRoot, 'dist-native/bin', target), { recursive: true });
    writeFileSync(fakeBinary, binaryContent, { mode: 0o755 });

    await execFileAsync(process.execPath, [packageScript], {
      cwd: appRoot,
      env: { ...process.env, KIMI_CODE_BUILD_TARGET: target },
    });

    const archivePath = resolve(artifactsDir, `kimi-code-${target}.zip`);
    const checksumPath = `${archivePath}.sha256`;
    expect(existsSync(archivePath)).toBe(true);
    expect(existsSync(checksumPath)).toBe(true);
    expect(zipEntryNames(archivePath)).toEqual([executableName]);
    expect(readZipEntry(archivePath, executableName).toString('utf-8')).toBe(binaryContent);
    expect(readFileSync(checksumPath, 'utf-8')).toBe(
      `${sha256(readFileSync(archivePath))}  kimi-code-${target}.zip\n`,
    );
  });

  it('inserts the engine segment into the archive name when configured', async () => {
    mkdirSync(resolve(appRoot, 'dist-native/bin', target), { recursive: true });
    writeFileSync(fakeBinary, 'bun binary payload\n', { mode: 0o755 });

    await execFileAsync(process.execPath, [packageScript], {
      cwd: appRoot,
      env: { ...process.env, KIMI_CODE_BUILD_TARGET: target, KIMI_CODE_NATIVE_ENGINE: 'bun' },
    });

    const archivePath = resolve(artifactsDir, `kimi-code-bun-${target}.zip`);
    expect(existsSync(archivePath)).toBe(true);
    expect(existsSync(`${archivePath}.sha256`)).toBe(true);
    expect(zipEntryNames(archivePath)).toEqual([executableName]);
  });

  function seaChecksum(target: string): string {
    return sha256(Buffer.from(`fake sea zip bytes for ${target}`));
  }

  function bunChecksum(target: string): string {
    return sha256(Buffer.from(`fake bun zip bytes for ${target}`));
  }

  async function writeFullArtifactSet(releaseDir: string): Promise<void> {
    for (const target of SUPPORTED_TARGETS) {
      await writeFile(
        join(releaseDir, `kimi-code-${target}.zip.sha256`),
        `${seaChecksum(target)}  kimi-code-${target}.zip\n`,
      );
      await writeFile(
        join(releaseDir, `kimi-code-bun-${target}.zip.sha256`),
        `${bunChecksum(target)}  kimi-code-bun-${target}.zip\n`,
      );
    }
  }

  it('produces a manifest from zip archive checksums', async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), 'kimi-manifest-zip-'));
    try {
      await writeFullArtifactSet(releaseDir);

      await execFileAsync(process.execPath, [
        manifestScript,
        releaseDir,
        '@moonshot-ai/kimi-code@0.5.0',
      ]);

      const manifest = JSON.parse(await readFile(join(releaseDir, 'manifest.json'), 'utf-8')) as {
        version: string;
        tag: string;
        platforms: Record<string, { filename: string; checksum: string }>;
        bun: Record<string, { filename: string; checksum: string }>;
      };
      expect(manifest.version).toBe('0.5.0');
      expect(manifest.tag).toBe('@moonshot-ai/kimi-code@0.5.0');
      expect(Object.keys(manifest.platforms).toSorted()).toEqual(SUPPORTED_TARGETS);
      expect(manifest.platforms['darwin-arm64']).toEqual({
        filename: 'kimi-code-darwin-arm64.zip',
        checksum: seaChecksum('darwin-arm64'),
      });
      expect(Object.keys(manifest.bun).toSorted()).toEqual(SUPPORTED_TARGETS);
      expect(manifest.bun['linux-x64']).toEqual({
        filename: 'kimi-code-bun-linux-x64.zip',
        checksum: bunChecksum('linux-x64'),
      });
    } finally {
      rmSync(releaseDir, { recursive: true, force: true });
    }
  });

  it('collects bun artifacts into a separate manifest section', async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), 'kimi-manifest-bun-'));
    await writeFile(join(releaseDir, 'manifest.json'), 'stale manifest');

    try {
      await writeFullArtifactSet(releaseDir);

      await execFileAsync(process.execPath, [
        manifestScript,
        releaseDir,
        '@moonshot-ai/kimi-code@0.5.0',
      ]);

      const manifest = JSON.parse(await readFile(join(releaseDir, 'manifest.json'), 'utf-8')) as {
        platforms: Record<string, { filename: string; checksum: string }>;
        bun?: Record<string, { filename: string; checksum: string }>;
      };
      expect(manifest.platforms['linux-x64']).toEqual({
        filename: 'kimi-code-linux-x64.zip',
        checksum: seaChecksum('linux-x64'),
      });
      expect(Object.fromEntries(
        Object.entries(manifest.bun ?? {}).map(([target, entry]) => [target, entry.checksum]),
      )).toEqual(Object.fromEntries(SUPPORTED_TARGETS.map((target) => [target, bunChecksum(target)])));
    } finally {
      rmSync(releaseDir, { recursive: true, force: true });
    }
  });

  it('fails when the bun section is incomplete', async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), 'kimi-manifest-partialbun-'));
    const [covered, ...missing] = SUPPORTED_TARGETS;
    if (covered === undefined || missing.length === 0) throw new Error('expected multiple supported targets');

    try {
      for (const target of SUPPORTED_TARGETS) {
        await writeFile(
          join(releaseDir, `kimi-code-${target}.zip.sha256`),
          `${seaChecksum(target)}  kimi-code-${target}.zip\n`,
        );
      }
      await writeFile(
        join(releaseDir, `kimi-code-bun-${covered}.zip.sha256`),
        `${bunChecksum(covered)}  kimi-code-bun-${covered}.zip\n`,
      );

      await expect(
        execFileAsync(process.execPath, [
          manifestScript,
          releaseDir,
          '@moonshot-ai/kimi-code@0.5.0',
        ]),
      ).rejects.toThrow(new RegExp(`No Bun.*${missing.join(', ')}`));
    } finally {
      rmSync(releaseDir, { recursive: true, force: true });
    }
  });

  it('fails when only bun artifacts are present and no platform would be published', async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), 'kimi-manifest-bunonly-'));
    const checksum = sha256(Buffer.from('fake bun zip bytes'));
    await writeFile(
      join(releaseDir, 'kimi-code-bun-linux-x64.zip.sha256'),
      `${checksum}  kimi-code-bun-linux-x64.zip\n`,
    );

    try {
      await expect(
        execFileAsync(process.execPath, [
          manifestScript,
          releaseDir,
          '@moonshot-ai/kimi-code@0.5.0',
        ]),
      ).rejects.toThrow(/No SEA/);
    } finally {
      rmSync(releaseDir, { recursive: true, force: true });
    }
  });
});
