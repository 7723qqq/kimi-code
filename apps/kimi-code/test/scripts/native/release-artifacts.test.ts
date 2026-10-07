import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';
import { ZipFile } from 'yazl';

import { SUPPORTED_TARGETS } from '../../../scripts/native/native-deps.mjs';
import { appRoot } from '../../../scripts/native/paths.mjs';

const execFileAsync = promisify(execFile);
const packageScript = resolve(appRoot, 'scripts/native/package.mjs');
const manifestScript = resolve(appRoot, 'scripts/native/produce-manifest.mjs');
const artifactsDir = resolve(appRoot, 'dist-native/artifacts');
const target = 'test-zip-artifact';
// Member/binary names follow the fake target's platform segment ('test' is not
// win32), independent of the platform running this test.
const executableName = 'kimi';
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

  function bunChecksum(target: string): string {
    return sha256(Buffer.from(`fake bun zip bytes for ${target}`));
  }

  // The script now unpacks each archive to emit its tar.gz / zst forms, so
  // the fixture has to be a real zip containing the platform executable —
  // a checksum file alone is no longer a complete input.
  async function writeFullArtifactSet(releaseDir: string): Promise<void> {
    const { ZipFile } = await import('yazl');
    for (const target of SUPPORTED_TARGETS) {
      const exeName = target.startsWith('win32') ? 'kimi.exe' : 'kimi';
      const binary = Buffer.from(`fake bun zip bytes for ${target}`);
      const zipName = `kimi-code-bun-${target}.zip`;
      const zipPath = join(releaseDir, zipName);
      const zip = new ZipFile();
      zip.addBuffer(binary, exeName, { mode: 0o100755 });
      zip.end();
      await pipeline(zip.outputStream, createWriteStream(zipPath));
      await writeFile(
        join(releaseDir, `${zipName}.sha256`),
        `${bunChecksum(target)}  ${zipName}\n`,
      );
    }
  }

  it('produces a manifest from bun archive checksums', async () => {
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
        bun: Record<string, { filename: string; checksum: string }>;
      };
      expect(manifest.version).toBe('0.5.0');
      expect(manifest.tag).toBe('@moonshot-ai/kimi-code@0.5.0');
      expect(Object.keys(manifest.bun).toSorted()).toEqual(SUPPORTED_TARGETS);
      expect(manifest.bun['darwin-arm64']).toEqual({
        filename: 'kimi-code-bun-darwin-arm64.zip',
        checksum: bunChecksum('darwin-arm64'),
      });
      expect(manifest).not.toHaveProperty('platforms');
    } finally {
      rmSync(releaseDir, { recursive: true, force: true });
    }
  });

  it('emits tar.gz and zst forms of each executable beside the manifest', async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), 'kimi-manifest-extra-'));
    try {
      await writeFullArtifactSet(releaseDir);

      await execFileAsync(process.execPath, [
        manifestScript,
        releaseDir,
        '@moonshot-ai/kimi-code@0.5.0',
      ]);

      for (const target of SUPPORTED_TARGETS) {
        const exeName = target.startsWith('win32') ? 'kimi.exe' : 'kimi';
        const binary = Buffer.from(`fake bun zip bytes for ${target}`);
        for (const ext of ['tar.gz', 'zst']) {
          const name = `kimi-code-${target}.${ext}`;
          const artifactPath = join(releaseDir, name);
          expect(existsSync(artifactPath)).toBe(true);

          // The sidecar must describe the artifact that shipped next to it.
          const sidecar = await readFile(`${artifactPath}.sha256`, 'utf-8');
          expect(sidecar).toBe(`${sha256(readFileSync(artifactPath))}  ${name}\n`);
        }

        // Both forms must inflate back to the same executable the zip holds.
        const extracted = join(releaseDir, `extract-${target}`);
        mkdirSync(extracted, { recursive: true });
        await execFileAsync('tar', [
          '-xzf',
          join(releaseDir, `kimi-code-${target}.tar.gz`),
          '-C',
          extracted,
        ]);
        expect(readFileSync(join(extracted, exeName))).toEqual(binary);

        const zstOut = join(extracted, `${exeName}.zst-out`);
        await execFileAsync('zstd', [
          '-d',
          '-q',
          '-f',
          join(releaseDir, `kimi-code-${target}.zst`),
          '-o',
          zstOut,
        ]);
        expect(readFileSync(zstOut)).toEqual(binary);
      }

      // The extra forms are release assets only: the manifest must keep
      // pointing at the zip, or clients would stage a bare binary.
      const manifest = JSON.parse(await readFile(join(releaseDir, 'manifest.json'), 'utf-8')) as {
        bun: Record<string, Record<string, unknown>>;
      };
      for (const target of SUPPORTED_TARGETS) {
        const entry = manifest.bun[target];
        expect(entry).toBeDefined();
        expect(entry?.['filename']).toBe(`kimi-code-bun-${target}.zip`);
        expect(entry).not.toHaveProperty('compressed');
        expect(entry).not.toHaveProperty('zstd');
      }
    } finally {
      rmSync(releaseDir, { recursive: true, force: true });
    }
  });

  it('fails when the bun section is incomplete', async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), 'kimi-manifest-partialbun-'));
    const [...missing] = SUPPORTED_TARGETS;
    const uncovered = missing.pop();
    if (uncovered === undefined || missing.length === 0)
      throw new Error('expected multiple supported targets');

    try {
      for (const target of missing) {
        await writeFile(
          join(releaseDir, `kimi-code-bun-${target}.zip.sha256`),
          `${bunChecksum(target)}  kimi-code-bun-${target}.zip\n`,
        );
      }

      await expect(
        execFileAsync(process.execPath, [
          manifestScript,
          releaseDir,
          '@moonshot-ai/kimi-code@0.5.0',
        ]),
      ).rejects.toThrow(new RegExp(`No Bun.*${uncovered}`));
    } finally {
      rmSync(releaseDir, { recursive: true, force: true });
    }
  });
});
